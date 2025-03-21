import { parse } from '@babel/parser'
import { ArrowFunctionExpression, FunctionExpression, isLoop, Node, ObjectMethod } from '@babel/types'
import { MakeOptional, Stack } from './utils'

export const kUninitialized = Symbol('Uninitialized')
export const kUserFunction = Symbol('UserFunction')
export const kParentScope = Symbol('ParentScope')
export const kAbort = Symbol('Abort')

export type Variable = any
export type UserFunction = ((...args: any[]) => any) & { [kUserFunction]?: boolean }
export type Scope = Record<string, Variable> & { [kParentScope]?: Scope }

export const enum AbortablePromiseStateType {
  Pending,
  Fulfilled,
  Rejected,
  Aborted,
}

export type AbortablePromiseState<T> =
  | { type: AbortablePromiseStateType.Pending }
  | { type: AbortablePromiseStateType.Fulfilled, value: T }
  | { type: AbortablePromiseStateType.Rejected, error: any }
  | { type: AbortablePromiseStateType.Aborted }

export type AbortablePromiseWithState<T> = AbortablePromise<T> & { state: AbortablePromiseState<T> }

export type PromiseExecutor<T> =
  (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void

export class AbortablePromise<T> extends Promise<T> {
  private abortController!: AbortController

  constructor(executor: PromiseExecutor<T>) {
    let abortController = new AbortController()
    super((resolve, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(kAbort)
      })
      return executor(resolve, reject)
    })
    this.abortController = abortController
  }

  static withState<T>(executor: PromiseExecutor<T>) {
    const promise: AbortablePromiseWithState<T> = Object.assign(
      new AbortablePromise(executor),
      { state: { type: AbortablePromiseStateType.Pending } satisfies AbortablePromiseState<T> }
    )
    promise
      .then(value => {
        promise.state = {
          type: AbortablePromiseStateType.Fulfilled,
          value
        }
      })
      .catch(error => {
        if (error === kAbort) {
          promise.state = {
            type: AbortablePromiseStateType.Aborted
          }
          return
        }
        promise.state = {
          type: AbortablePromiseStateType.Rejected,
          error
        }
      })
    return promise
  }

  static isPromiseWithState(value: any): value is AbortablePromiseWithState<any> {
    return value instanceof AbortablePromise && 'state' in value
  }

  abort() {
    this.abortController.abort()
  }
}

export type OnRet = (frame: ExecutionFrame, value?: any) => void
export namespace OnRet {
  export const discard: OnRet = () => {}
  export const asState: OnRet = (frame, value) => {
    frame.state = value
  }
  export const asStateProp: (prop: string) => OnRet = (prop) => (frame, value) => {
    (frame.state ??= {})[prop] = value
  }
}

export interface ExecutionOptions {
  rootNode: Node
  desc?: string
  code?: string
  rootScope: Scope
  runtime: Runtime
}

export interface ExecutionFrame {
  node: Node
  role?: string
  name?: string
  index: number
  subIndex: number
  state?: any
  onRet: OnRet
  scope: Scope
}
export type ExecutionStack = Stack<ExecutionFrame>

export interface ExecutionState {
  stack: ExecutionStack
  awaitingPromise: AbortablePromiseWithState<any> | null
}

export interface Execution {
  state: ExecutionState

  step(): void
  start(): void
  wait(): Promise<void>
}

export interface RuntimeOptions {
  isDebug?: boolean
}

export interface Runtime {
  executions: Execution[]
  isDebug?: boolean
  debugInfo: {
    maxDescLength: number
    maxStepLength: number
  }

  execute(
    code: string,
    options: Pick<ExecutionOptions, 'desc' | 'rootScope'>
  ): Execution
}

export const createRuntime = (
  { isDebug }: RuntimeOptions = {}
): Runtime => {
  const executions: Execution[] = []

  const execute: Runtime['execute'] = (
    code: string,
    { desc = 'root', rootScope = {} }
  ) => {
    const parseResult = parse(code, { sourceType: 'module' })

    return createExecution({
      rootNode: parseResult.program,
      code,
      desc,
      rootScope,
      runtime,
    })
  }

  const runtime: Runtime = {
    executions,
    isDebug,
    debugInfo: {
      maxDescLength: 10,
      maxStepLength: 4,
    },
    execute
  }

  return runtime
}

export const withGlobal = (scope: Scope): Scope => {
  Object.getOwnPropertyNames(globalThis).forEach(key => {
    scope[key] ??= globalThis[key as keyof typeof globalThis]
  })
  return scope
}

export const createExecution = ({
  rootNode, desc, code, rootScope, runtime
}: ExecutionOptions): Execution => {
  const id = '#' + runtime.executions.length
  desc = (desc ?? '') + id

  const state: ExecutionState = {
    stack: new Stack<ExecutionFrame>(),
    awaitingPromise: null,
  }
  const { stack } = state

  const push = ({
    scope = stack.top!.scope,
    ...frame
  }: MakeOptional<Omit<ExecutionFrame, 'index' | 'subIndex'>, 'scope'>) => {
    stack.push({
      ...frame,
      scope,
      index: 0,
      subIndex: 0
    })
  }

  const ret = (value?: any) => {
    const frame = stack.pop()!
    const parentFrame = stack.top
    if (parentFrame) {
      parentFrame.subIndex ++
      frame.onRet(parentFrame, value)
      if (runtime.isDebug) {
        const { debugInfo } = runtime
        console.debug(
          '[%s:\x1B[32m%s\x1B[0m] %s→ %O',
          desc.padStart(debugInfo.maxDescLength),
          stepCounter.toString().padEnd(debugInfo.maxStepLength),
          ' '.repeat(2 * stack.length),
          value,
        )
      }
    }
  }

  const resolve = (name: string, scope: Scope): Scope | undefined => {
    if (name in scope) return scope
    if (scope[kParentScope]) return resolve(name, scope[kParentScope])
    return undefined
  }

  const inheritScope = (scope: Scope): Scope => {
    const childScope: Scope = {}
    childScope[kParentScope] = scope
    return childScope
  }

  const buildFunc = (
    frame: ExecutionFrame,
    node: FunctionExpression | ArrowFunctionExpression | ObjectMethod,
    name = ''
  ) => {
    const { [name]: func }: { [name]: UserFunction } = {
      [name]: function (this: any, ...args: any[]) {
        const funcScope = inheritScope(frame.scope)
        if (node.type !== 'ArrowFunctionExpression') {
          funcScope.this = this
        }
        node.params.forEach((param, index) => {
          switch (param.type) {
            case 'Identifier':
              funcScope[param.name] = args[index]
              return
            case 'RestElement':
              switch (param.argument.type) {
                case 'Identifier':
                  funcScope[param.argument.name] = args.slice(index)
                  return
                default:
                  throw new Error(`Unsupported RestElement.argument.type: ${param.argument.type}`)
              }
            default:
              throw new Error(`Unsupported ArrowFunctionExpression.params.type: ${param.type}`)
          }
        })

        let hasReturned = false
        let retValue: any
        const bodyFrame: ExecutionFrame = {
          node: node.body,
          role: 'call',
          index: 0, subIndex: 0,
          onRet: (_, value) => {
            hasReturned = true
            retValue = value
          },
          scope: funcScope,
        }
        const funcExecution = createExecution({
          rootNode: node.body,
          desc: name ? `ƒ ${name}` : 'λ',
          code,
          rootScope: funcScope,
          runtime,
        })
        funcExecution.state.stack.push(bodyFrame)

        if (node.async) {
          return new AbortablePromise((resolve) => {
            const next = () => {
              if (! funcExecution.state.stack.length) {
                return resolve(undefined)
              }
              funcExecution.step()
              if (hasReturned) return resolve(retValue)
              if (funcExecution.state.awaitingPromise) {
                funcExecution.state.awaitingPromise.then(next)
              }
              else {
                next()
              }
            }
            next()
          })
        }

        while (true) {
          if (! funcExecution.state.stack.length) {
            return undefined
          }
          funcExecution.step()
          if (hasReturned) return retValue
        }
      }
    }
    func[kUserFunction] = true
    return func
  }

  let stepCounter = 0
  let stepCode = ''

  const step = () => {
    const frame = stack.top
    if (! frame) {
      throw new Error(`[${desc}] Execution stack is empty`)
    }

    const { node } = frame

    if (code) {
      const lines = code.slice(node.start!, node.end!).split('\n')
      stepCode = lines[0] + (lines.length > 1 ? '...' : '')
    }
  
    if (runtime.isDebug) {
      const { debugInfo } = runtime
      const stepStr = stepCounter.toString()
      if (desc.length > debugInfo.maxDescLength) debugInfo.maxDescLength = desc.length
      if (stepStr.length > debugInfo.maxStepLength) debugInfo.maxStepLength = stepStr.length
      console.debug(
        '[%s:\x1B[32m%s\x1B[0m] %s%s \x1B[32m%d\x1B[0m:\x1B[32m%d\x1B[0m \x1B[36m%s\x1B[0m',
        desc.padStart(debugInfo.maxDescLength),
        stepStr.padEnd(debugInfo.maxStepLength),
        ' '.repeat(2 * (stack.length - 1)),
        node.type, frame.index, frame.subIndex, stepCode
      )
      stepCounter ++
    }

    switch (node.type) {
      case 'BlockStatement':
      case 'Program': {
        const state: { blockScope: Scope }
          = frame.state ??= { blockScope: inheritScope(frame.scope) }
        if (frame.index === node.body.length) {
          if (node.type === 'Program') {
            if (code) {
              console.debug('Code:\n\x1B[36m%s\x1B[0m', code.replace(/^/gm, '  '))
            }
            console.debug('Program scope: %O', state.blockScope)
          }
          return ret()
        }
        const stmt = node.body[frame.index]
        switch (frame.subIndex) {
          case 0:
            return push({
              node: stmt,
              onRet: OnRet.discard,
              scope: state.blockScope,
            })
          case 1:
            frame.subIndex = 0
            frame.index ++
            return
        }
        return
      }
      case 'ReturnStatement': {
        switch (frame.subIndex) {
          case 0:
            if (! node.argument) {
              frame.subIndex ++
              return
            }
            return push({
              node: node.argument,
              onRet: OnRet.asState,
            })
          case 1:
            while (true) {
              if (stack.top.role === 'call') {
                return ret(frame.state)
              }
              stack.pop()
            }
        }
        return
      }
      case 'BreakStatement': {
        while (true) {
          if (isLoop(stack.top.node)) {
            return ret()
          }
          stack.pop()
        }
      }
      case 'ContinueStatement': {
        while (true) {
          if (isLoop(stack.top.node)) {
            stack.top.subIndex = 0
            switch (stack.top.node.type) {
              case 'ForStatement':
                stack.top.index = 3
                return
              case 'WhileStatement':
                stack.top.index = 0
                return
              case 'DoWhileStatement':
                stack.top.index = 1
                return
            }
          }
          stack.pop()
        }
      }
      case 'ExpressionStatement': {
        switch (frame.subIndex) {
          case 0:
            return push({
              node: node.expression,
              onRet: OnRet.discard,
            })
          case 1:
            return ret()
        }
        return
      }
      case 'IfStatement': {
        const { test, consequent, alternate } = node
        switch (frame.subIndex) {
          case 0:
            return push({
              node: test,
              onRet: OnRet.asState,
            })
          case 1:
            if (frame.state) {
              return push({
                node: consequent,
                onRet: OnRet.discard,
              })
            }
            else if (alternate) {
              return push({
                node: alternate,
                onRet: OnRet.discard,
              })
            }
            else {
              return ret()
            }
          case 2:
            return ret()
        }
        return
      }
      case 'ForStatement': {
        const state: { test: any, initScope: Scope }
          = frame.state ??= { initScope: inheritScope(frame.scope) }
        switch (frame.index) {
          case 0:
            if (node.init) {
              switch (frame.subIndex) {
                case 0:
                  return push({
                    node: node.init,
                    onRet: OnRet.discard,
                    scope: state.initScope,
                  })
                case 1:
                  frame.index = 1
                  frame.subIndex = 0
              }
            }
          case 1:
            if (node.test) {
              switch (frame.subIndex) {
                case 0:
                  return push({
                    node: node.test,
                    onRet: OnRet.asStateProp('test'),
                    scope: state.initScope,
                  })
                case 1:
                  if (! state.test) return ret()
                  frame.index = 2
                  frame.subIndex = 0
              }
            }
          case 2:
            switch (frame.subIndex) {
              case 0:
                return push({
                  node: node.body,
                  onRet: OnRet.discard,
                  scope: { ...state.initScope },
                })
              case 1:
                frame.index = 3
                frame.subIndex = 0
            }
          case 3:
            switch (frame.subIndex) {
              case 0:
                if (node.update) {
                  return push({
                    node: node.update,
                    onRet: OnRet.discard,
                    scope: state.initScope,
                  })
                }
              case 1:
                frame.index = 1
                frame.subIndex = 0
            }
        }
        return
      }
      case 'DoWhileStatement':
      case 'WhileStatement': {
        const state: { test?: any } = frame.state ??= {}
        switch (node.type === 'WhileStatement' ? frame.index : 1 - frame.index) {
          case 0:
            switch (frame.subIndex) {
              case 0:
                return push({
                  node: node.test,
                  onRet: OnRet.asStateProp('test'),
                })
              case 1:
                if (! state.test) return ret()
                frame.index = 1 - frame.index
                frame.subIndex = 0
            }
          case 1:
            switch (frame.subIndex) {
              case 0:
                return push({
                  node: node.body,
                  onRet: OnRet.discard,
                })
              case 1:
                frame.index = 1 - frame.index
                frame.subIndex = 0
            }
        }
        return
      }
      case 'VariableDeclaration': {
        const declaration = node.declarations[frame.index]
        switch (declaration.id.type) {
          case 'Identifier': {
            const { name } = declaration.id
            if (! declaration.init) {
              frame.scope[name] = undefined
            }
            else {
              switch (frame.subIndex) {
                case 0:
                  frame.scope[name] = kUninitialized
                  return push({
                    node: declaration.init,
                    onRet: OnRet.asState,
                    name,
                  })
                case 1:
                  frame.scope[name] = frame.state
                  frame.state = undefined
                  frame.subIndex = 0
                  break
              }
            }
            if (++ frame.index === node.declarations.length) {
              ret()
            }
            return
          }
          default:
            throw new Error(`Unsupported VariableDeclaration.id.type: ${declaration.id.type}`)
        }
      }
      case 'BooleanLiteral':
      case 'NumericLiteral':
      case 'NumberLiteral':
      case 'StringLiteral':
      case 'BigIntLiteral':
        return ret(node.value)
      case 'RegExpLiteral':
        return ret(new RegExp(node.pattern, node.flags))
      case 'NullLiteral':
        return ret(null)
      case 'ObjectExpression': {
        const state: { object: Record<keyof any, any>, currentKey: keyof any, currentValue: any }
          = frame.state ??= { object: {} }
        if (frame.index === node.properties.length) {
          return ret(state.object)
        }
        const property = node.properties[frame.index]
        switch (property.type) {
          case 'ObjectProperty':
            switch (frame.subIndex) {
              case 0:
                return push({
                  node: property.key,
                  role: 'key',
                  onRet: OnRet.asStateProp('currentKey'),
                })
              case 1:
                return push({
                  node: property.value,
                  onRet: OnRet.asStateProp('currentValue'),
                })
              case 2: {
                const { currentKey, currentValue } = state
                state.object[currentKey] = currentValue
                frame.subIndex = 0
                frame.index ++
                return
              }
            }
            return
          case 'ObjectMethod':
            switch (frame.subIndex) {
              case 0:
                return push({
                  node: property.key,
                  role: 'key',
                  onRet: OnRet.asStateProp('currentKey'),
                })
              case 1:
                const method = buildFunc(frame, property, String(state.currentKey))
                state.object[state.currentKey] = method
                frame.subIndex = 0
                frame.index ++
                return
            }
            return
          case 'SpreadElement':
            switch (frame.subIndex) {
              case 0:
                return push({
                  node: property.argument,
                  onRet: OnRet.asStateProp('currentValue'),
                })
              case 1:
                Object.assign(state.object, state.currentValue)
                frame.subIndex = 0
                frame.index ++
                return
            }
          default:
            throw new Error(`Unsupported ObjectExpression.property.type ${property.type}`)
        }
      }
      case 'ArrayExpression': {
        const state: { array: any[], index: number, currentElement: any } =
          frame.state ??= { array: [], index: 0 }
        if (frame.index === node.elements.length) {
          return ret(state.array)
        }
        const element = node.elements[frame.index]

        if (element === null) {
          frame.state.index ++
          frame.index ++
          return
        }
      
        switch (frame.subIndex) {
          case 0:
            return push({
              node: element.type === 'SpreadElement'
                ? element.argument
                : element,
              onRet: OnRet.asStateProp('currentElement'),
            })
          case 1:
            switch (element.type) {
              case 'SpreadElement': {
                const length = state.array.push(...frame.state.currentElement)
                state.index += length
                frame.subIndex = 0
                frame.index ++
                return
              }
              default:
                state.array[state.index ++] = state.currentElement
                frame.subIndex = 0
                frame.index ++
                return
            }
        }
        return
      }
      case 'OptionalMemberExpression':
      case 'MemberExpression': {
        switch (frame.subIndex) {
          case 0: {
            return push({
              node: node.object,
              onRet: OnRet.asStateProp('object'),
            })
          }
          case 1: {
            return push({
              node: node.property,
              role: node.computed ? undefined : 'key',
              onRet: OnRet.asStateProp('key'),
            })
          }
          case 2: {
            const { object, key } = frame.state
            if (frame.role === 'left') {
              return ret({ object, key })
            }
            const value = node.type === 'OptionalMemberExpression'
              ? object?.[key]
              : object[key]
            if (frame.role === 'callee') {
              return ret({
                function: value,
                this: object,
              })
            }
            return ret(value)
          }
        }
        return
      }
      case 'UnaryExpression': {
        const { argument: arg } = node
        switch (frame.subIndex) {
          case 0:
            return push({
              node: arg,
              onRet: OnRet.asStateProp('arg'),
            })
          case 1: {
            const { arg } = frame.state
            switch (node.operator) {
              case '!': return ret(! arg)
              case '~': return ret(~ arg)
              case '+': return ret(+ arg)
              case '-': return ret(- arg)
              case 'void': return ret(undefined)
              case 'typeof': return ret(typeof arg)
              case 'throw': throw new Error('Throw is not implemented')
              case 'delete': throw new Error('Delete is not implemented')
            }
          }
        }
        return
      }
      case 'LogicalExpression':
      case 'BinaryExpression': {
        const state: { lhs: any, rhs: any } = frame.state ??= {}
        const { left, right } = node
        switch (frame.subIndex) {
          case 0:
            return push({
              node: left,
              onRet: OnRet.asStateProp('lhs'),
            })
          case 1: {
            const { lhs } = state
            if (
              (node.operator === '&&' && ! lhs) ||
              (node.operator === '||' && lhs) ||
              (node.operator === '??' && lhs != null)
            ) return ret(lhs)
            return push({
              node: right,
              onRet: OnRet.asStateProp('rhs'),
            })
          }
          case 2: {
            const { lhs, rhs } = state
            switch (node.operator) {
              case '+':
                return ret(lhs + rhs)
              case '-':
                return ret(lhs - rhs)
              case '*':
                return ret(lhs * rhs)
              case '/':
                return ret(lhs / rhs)
              case '**':
                return ret(lhs ** rhs)
              case '%':
                return ret(lhs % rhs)
              case '&':
                return ret(lhs & rhs)
              case '|':
                return ret(lhs | rhs)
              case '^':
                return ret(lhs ^ rhs)
              case '<<':
                return ret(lhs << rhs)
              case '>>':
                return ret(lhs >> rhs)
              case '>>>':
                return ret(lhs >>> rhs)
              case '==':
                return ret(lhs == rhs)
              case '!=':
                return ret(lhs != rhs)
              case '===':
                return ret(lhs === rhs)
              case '!==':
                return ret(lhs !== rhs)
              case '<':
                return ret(lhs < rhs)
              case '<=':
                return ret(lhs <= rhs)
              case '>':
                return ret(lhs > rhs)
              case '>=':
                return ret(lhs >= rhs)
              case '|>':
                return ret(rhs(lhs))
              case 'in':
                return ret(lhs in rhs)
              case 'instanceof':
                return ret(lhs instanceof rhs)
              case '&&':
              case '||':
              case '??':
                return ret(rhs)
            }
          }
        }
        return
      }
      case 'ConditionalExpression': {
        switch (frame.subIndex) {
          case 0:
            return push({
              node: node.test,
              onRet: OnRet.asStateProp('test'),
            })
          case 1:
            return push({
              node: frame.state.test ? node.consequent : node.alternate,
              onRet: OnRet.asStateProp('value'),
            })
          case 2:
            return ret(frame.state.value)
        }
      }
      case 'ThisExpression':
      case 'Identifier': {
        const name = node.type === 'Identifier' ? node.name : 'this'

        if (frame.role === 'key') {
          return ret(name)
        }
        const scope = resolve(name, frame.scope)
        if (! scope) 
          throw new Error(`Variable ${name} is not defined`)

        const variable = scope[name]
        if (variable === kUninitialized) {
          throw new Error(`Variable ${name} has not been initialized`)
        }

        if (frame.role === 'left') {
          return ret({ object: scope, key: name })
        }
        
        if (frame.role === 'callee') {
          return ret({
            function: variable,
            this: undefined
          })
        }
        return ret(variable)
      }
      case 'AssignmentExpression': {
        const { left, right } = node
        switch (frame.subIndex) {
          case 0:
            return push({
              node: right,
              onRet: OnRet.asStateProp('right'),
            })
          case 1:
            return push({
              node: left,
              role: 'left',
              onRet: OnRet.asStateProp('left'),
            })
          case 2: {
            const { left: lhs, right: rhs } = frame.state
            let value = lhs.object[lhs.key]
      
            switch (node.operator) {
              case '=':
                value = rhs
                break
              case '+=':
                value += rhs
                break
              case '-=':
                value -= rhs
                break
              case '*=':
                value *= rhs
                break
              case '/=':
                value /= rhs
                break
              case '**=':
                value **= rhs
                break
              case '%=':
                value %= rhs
                break
              case '&=':
                value &= rhs
                break
              case '|=':
                value |= rhs
                break
              case '^=':
                value ^= rhs
                break
              case '<<=':
                value <<= rhs
                break
              case '>>=':
                value >>= rhs
                break
              case '>>>=':
                value >>>= rhs
                break
              case '&&=':
                value ??= rhs
                break
              case '||=':
                value ??= rhs
                break
              case '??=':
                value ??= rhs
                break
              default:
                throw new Error(`Unsupported AssignmentExpression.operator ${node.operator}`)
            }

            lhs.object[lhs.key] = value
          
            frame.state = undefined
            return ret(value)
          }
        }
        break
      }
      case 'UpdateExpression': {
        switch (frame.subIndex) {
          case 0:
            return push({
              node: node.argument,
              role: 'left',
              onRet: OnRet.asState,
            })
          case 1: {
            const arg = frame.state
            switch (node.operator) {
              case '++':
                return ret(node.prefix
                  ? ++ arg.object[arg.key]
                  : arg.object[arg.key] ++
                )
              case '--':
                return ret(node.prefix
                  ? -- arg.object[arg.key]
                  : arg.object[arg.key] --
                )
            }
          }
        }
        return
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const func = buildFunc(frame, node, frame.name)
        return ret(func)
      }
      case 'NewExpression':
      case 'OptionalCallExpression':
      case 'CallExpression': {
        const argsLength = node.arguments.length
        const state: {
          args: any[]
          callee: {
            function: UserFunction
            this: any
          }
          currentArg: any
          ret: any 
        } = frame.state ??= { args: [] }
        if (frame.index < argsLength) {
          const argument = node.arguments[frame.index]
          switch (frame.subIndex) {
            case 0:
              return push({
                node: argument.type === 'SpreadElement'
                  ? argument.argument
                  : argument,
                onRet: OnRet.asStateProp('currentArg'),
              })
            case 1: {
              switch (argument.type) {
                case 'SpreadElement':
                  state.args.push(...frame.state.currentArg)
                  break
                default:
                  state.args.push(frame.state.currentArg)
                  break
              }
              frame.subIndex = 0
              frame.index ++
              return
            }
          }
        }
        else if (frame.index === argsLength) {
          switch (frame.subIndex) {
            case 0:
              return push({
                node: node.callee,
                role: 'callee',
                onRet: OnRet.asStateProp('callee'),
              })
            case 1: {
              const { callee, args } = state
              if (node.type === 'OptionalCallExpression' && callee.function == null) {
                return ret(callee.function)
              }
              return ret(node.type === 'NewExpression'
                ? new (callee.function as any)(...args)
                : callee.function.call(callee.this, ...args)
              )
            }
            case 2:
              return ret(state.ret)
          }
        }
        return
      }
      case 'AwaitExpression': {
        switch (frame.subIndex) {
          case 0:
            return push({
              node: node.argument,
              onRet: OnRet.asState,
            })
          case 1: {
            const arg = frame.state
            if (state.awaitingPromise) {
              throw new Error('Awaiting promise is already set')
            }
            if (AbortablePromise.isPromiseWithState(arg)) {
              state.awaitingPromise = arg
            }
            else if ('then' in arg) {
              state.awaitingPromise = AbortablePromise.withState((resolve, reject) => {
                arg.then(resolve, reject)
              })
            }
            else {
              return ret(arg)
            }
            frame.subIndex = 2
            return
          }
          case 2: {
            if (! state.awaitingPromise) {
              throw new Error('Awaiting promise is not set')
            }
            const { awaitingPromise } = state
            if (awaitingPromise.state.type === AbortablePromiseStateType.Pending) return
            state.awaitingPromise = null

            switch (awaitingPromise.state.type) {
              case AbortablePromiseStateType.Fulfilled:
                return ret(awaitingPromise.state.value)
              case AbortablePromiseStateType.Rejected:
                throw awaitingPromise.state.error
              case AbortablePromiseStateType.Aborted:
                throw kAbort
            }
          }
        }
        return
      }
      default:
        throw new Error(`Unsupported Node.type: ${node.type}`)
    }
  }

  const next = (resolve: () => void) => {
    if (! stack.length) return resolve()
    step()
    if (state.awaitingPromise) {
      state.awaitingPromise.then(() => next(resolve))
    }
    else {
      next(resolve)
    }
  }

  const start = () => next(() => {})
  const wait = () => new Promise<void>(resolve => next(resolve))

  push({
    node: rootNode,
    onRet: OnRet.discard,
    scope: rootScope,
  })
  
  const execution: Execution = {
    state,
    step,
    start,
    wait,
  }
  runtime.executions.push(execution)

  return execution
}
