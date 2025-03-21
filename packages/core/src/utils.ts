export class Stack<T> extends Array<T> {
  get top() {
    return this[this.length - 1]
  }
}

export type MakeOptional<T, K extends keyof T>
  = Omit<T, K> & Partial<Pick<T, K>>