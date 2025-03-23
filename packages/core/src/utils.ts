export class Stack<T> extends Array<T> {
  get top() {
    return this[this.length - 1]
  }
}

export type MakeOptional<T, K extends keyof T>
  = Omit<T, K> & Partial<Pick<T, K>>

export const remove = <T>(array: T[], pred: (value: T) => boolean) => {
  const index = array.findIndex(pred)
  if (index >= 0) array.splice(index, 1)
}

export const eq = <T>(lhs: T) => (rhs: T) => lhs === rhs