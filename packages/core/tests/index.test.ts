import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'

import { test } from 'vitest'

import { createRuntime, withGlobal } from '../src'

test('execute', async () => {
  const codePath = join(dirname(fileURLToPath(import.meta.url)), './input.js')
  const code = await readFile(codePath, 'utf-8')

  const globalScope = withGlobal({
    [inspect.custom]: () => '[Global]',
    console: {
      log: (fmt: string, ...args: any[]) => console.log(`Log : \x1B[45m${fmt}\x1B[0m`, ...args),
    }
  })

  const runtime = createRuntime({
    isDebug: !! process.env.DEBUG,
  })

  const execution = runtime.execute(code, {
    desc: 'root',
    rootScope: globalScope,
  })
  await execution.wait()
})