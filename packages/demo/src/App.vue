<script setup lang="ts">
import { reactive, ref, shallowReactive, watch } from 'vue'
import { createRuntime, withGlobal, type Runtime } from 'fkio'
import Divider from './components/Divider.vue'

const COLORS: Record<string, string> = {
  0: '#000000',
  1: '#cd3131',
  2: '#0dbc79',
  3: '#e5e510',
  4: '#2472c8',
  5: '#bc3fbc',
  6: '#11a8cd',
  7: '#e5e5e5',
}

const scrollLogs = () => {
  setTimeout(() => {
    const el = logsContentEl.value!
    el.children[el.children.length - 1]?.scrollIntoView()
  }, 0)
}

const scrollToCode = () => {
  codeEl.value!.scrollIntoView({ behavior: 'smooth' })
}

const scrollToLogs = () => {
  consoleEl.value!.scrollIntoView({ behavior: 'smooth' })
}

const prettyDisplay = (obj: any) =>
  typeof obj === 'number' ? `<pd-number>${ obj }</pd-number>` :
  typeof obj === 'string' ? `<pd-string>${ obj }</pd-string>` :
  typeof obj === 'boolean' ? `<pd-boolean>${ obj }</pd-boolean>` :
  typeof obj === 'symbol' ? `<pd-symbol>${ obj.description }</pd-symbol>` :
  typeof obj === 'function' ? `<pd-function>${ obj.name || '(anonymous)' }</pd-function>` :
  obj === null ? '<pd-null></pd-null>' :
  obj === undefined ? '<pd-undefined></pd-undefined>' :
  Array.isArray(obj) ? `
    <pd-array>${ obj
      .map((child): string => `<pd-item>${ prettyDisplay(child) }</pd-item>`)
      .join('')
    }</pd-array>
  `.trim() : `
    <pd-object data-tag="${obj[Symbol.toStringTag] ? obj[Symbol.toStringTag] + ' ' : ''}">${ Object
      .entries(obj)
      .map(([ key, value ]): string => `
        <pd-item><pd-key>${ key }</pd-key><pd-value>${ prettyDisplay(value) }</pd-value></pd-item>
      `.trim())
      .join('')
    }</pd-object>
  `.trim()

const MAX_LOG_COUNT = 1000

const state = ref<'idle' | 'waiting'>('idle')
const isDebug = ref(true)

const EXAMPLE_CODE = `
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const f = async () => {
    await sleep(1000)
    console.log('Hello, world!')
}

const g = async () => {
    await f()
    await f()
}

await g()
`.trimStart()

const code = ref(localStorage.getItem('code') || EXAMPLE_CODE)
watch(code, (value) => localStorage.setItem('code', value))

const logs = reactive<string[]>([])

console.debug = (fmt: string, ...args: any[]) => {
  let i = 0
  if (fmt.includes('vite')) return  
  const msg = fmt
    .replace(/ /g, '&nbsp;')
    .replace(/%([sdoO])/g, (_, type: string) => {
      if (type.toLowerCase() === 'o') return prettyDisplay(args[i ++])
      return String(args[i ++])
    })
    .replace(/\x1B\[([34])(\d)m([^]*?)\x1B\[0m/g, (_, type: string, color: string, text: string) => {
      return `<span style="${type === '3' ? 'color' : 'background-color'}: ${COLORS[color]};">${text}</span>`
    })

  logs.push(msg)
  const rt = runtime.value
  if (logs.length === MAX_LOG_COUNT && rt?.isDebug) {
    rt.isDebug = false
    console.debug('\x1B[41mToo many logs. Debug mode is turned off.\x1B[0m')
  }
  scrollLogs()
}

const log = (fmt: string, ...args: any[]) => {
  console.debug(`\x1B[45m${fmt}\x1B[0m`, ...args)
}

const logsContentEl = ref<HTMLElement | null>(null)
const codeEl = ref<HTMLElement | null>(null)
const consoleEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const runtimeEl = ref<HTMLElement | null>(null)

let runtime = ref<Runtime | null>(null)

const toggleDebug = () => {
  isDebug.value = ! isDebug.value
  if (runtime.value) runtime.value.isDebug = isDebug.value
}

const executeCode = async () => {
  if (state.value !== 'idle') return
  state.value = 'waiting'
  consoleEl.value!.scrollIntoView({ behavior: 'smooth' })
  logs.splice(0)
  const rt = runtime.value = createRuntime({
    isDebug: isDebug.value,
  })
  rt.executions = shallowReactive(rt.executions)
  try {
    const execution = rt.execute(code.value, {
      desc: 'demo',
      rootScope: withGlobal({
        console: { log },
      }),
    })
    await execution.wait()
  }
  catch (err) {
    console.debug(`\x1B[33m${err}\x1B[0m`)
  }
  state.value = 'idle'
}
</script>

<template>
  <div class="root">
    <h1>fkio.js</h1>
    <div class="main">
      <div class="code" ref="codeEl">
        <div class="code-inner" @click="scrollToCode">
          <div class="title">
            Code
            <div class="button-group">
              <button @click="executeCode" :disabled="state !== 'idle'">
                <template v-if="state === 'idle'">Run</template>
                <template v-else-if="state === 'waiting'">Running...</template>
              </button>
              <button @click="toggleDebug">Debug {{ isDebug ? 'ON' : 'OFF' }}</button>
              <button @click.capture.prevent="scrollToLogs">↓</button>
            </div>
          </div>
          <textarea
            v-model="code"
            @focus="scrollToCode"
            spellcheck="false"
            ref="textareaEl"
          ></textarea>
        </div>
      </div>
      <div class="console" ref="consoleEl">
        <div class="console-inner" @click="scrollToLogs">
          <div class="title">
            Console
            <div class="button-group">
              <button @click.capture.prevent="scrollToCode">↑</button>
            </div>
          </div>
          <div class="console-main">
            <div class="logs">
              <div class="title">Logs</div>
              <div class="logs-content" ref="logsContentEl">
                <pre v-for="log of logs" class="log" v-html="log"></pre>
              </div>
            </div>
            <Divider :adjust-dir="- 1" :el="runtimeEl" />
            <div class="runtime" ref="runtimeEl">
              <div class="title">Runtime</div>
              <template v-if="runtime">
                <div v-for="execution of runtime.executions" class="execution">
                  <span class="execution-desc">{{ execution.desc }}</span>:&nbsp;
                  <span class="execution-state">{{ execution.state.awaitingPromise ? 'Awaiting' : 'Running' }}</span>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.root {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.main {
  display: flex;
  flex-direction: column;
  flex-wrap: wrap;
  justify-content: space-between;
  width: 100%;
  padding: 2em;
  box-sizing: border-box;
}

.code, .console {
  padding: 1em;
  height: calc(100vh - 4em);
  width: calc(100% - 2em);
}

.code {
  margin-bottom: 2em;
}

.code-inner, .console-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: #1e1e1e;
  color: #ffffff;
  border-radius: .5em;
  padding: 1em;
  box-shadow: 0 0 1em #000000ee;
}

textarea {
  width: 100%;
  flex: 1;
  background-color: #1e1e1e;
  color: #ffffff;
  border: none;
  resize: vertical;
  font-family: monospace;
  font-size: 1em;
  padding: .5em;
  box-sizing: border-box;
  outline: none;
  border-radius: .5em;
  transition: box-shadow .3s;
  box-shadow: 0 0 1em #ffffffcc;
}

textarea:focus {
  box-shadow: 0 0 1em #ffffffff;
}

.title {
  display: flex;
  justify-content: space-between;
  padding: 0 1em;
  margin-bottom: 1em;
}

button {
  padding: .2em;
  border: none;
  outline: none;
  background-color: inherit;
  color: inherit;
  font: inherit;
}
button::before {
  content: '<';
}
button::after {
  content: '>';
}
button:disabled:before {
  content: '[';
}
button:disabled:after {
  content: ']';
}

button:not(:disabled):hover {
  text-decoration: underline;
  cursor: pointer;
}

.console-main {
  display: flex;
  height: 100%;
  min-height: 0;
}

.runtime {
  min-width: 8em;
}

.execution {
  white-space: nowrap;
}

.execution-desc {
  font-family: 'Fira Code', 'Consolas', monospace;
}

.divider {
  margin: 0 5px;
}

.logs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 50%;
}

.logs-content {
  font-size: .8em;
  overflow: scroll;
}

.log {
  display: flex;
  margin: 0;
}

textarea, pre {
  font-family: 'Fira Code', 'Consolas', monospace;
}

pd-item {
  margin-left: 2ch;
  display: block;
}
pd-item::after {
  content: ',';
  color: #a8ccce;
}
.log > pd-object {
  display: inline-block;
}
pd-object::before {
  content: attr(data-tag) '{';
  color: #a8ccce;
}
pd-object::after {
  content: '}';
  color: #a8ccce;
}
pd-array::before {
  content: '[';
  color: #a8ccce;
}
pd-array::after {
  content: ']';
  color: #a8ccce;
}
pd-key::after {
  content: ': ';
  color: #a8ccce;
}
pd-number {
  color: #e5e510;
}
pd-symbol {
  color: #0dbc79;
}
pd-string::before {
  content: '\'';
}
pd-string::after {
  content: '\'';
}
pd-string {
  color: #0dbc79;
}
pd-boolean {
  color: #e5e510;
}
pd-null::after {
  content: 'null';
}
pd-null {
  color: #e5e5e5;
  font-weight: bold;
}
pd-undefined::after {
  content: 'undefined';
}
pd-undefined {
  color: #7c8c8d;
}
pd-function::before {
  content: '[Function: ';
  color: #a8ccce;
}
pd-function::after {
  content: ']';
  color: #a8ccce;
}
</style>
