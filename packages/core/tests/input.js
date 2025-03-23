const calc = (N) => {
  let sum = 0, div = 1, sgn = 1
  for (let i = 0; i < N; i ++) {
    sum += sgn / div
    div += 2
    sgn *= - 1
  }
  return sum * 4
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const profile = async fn => {
  const timeStart = Date.now()
  await fn()
  const timeEnd = Date.now()
  const duration = timeEnd - timeStart
  console.log('%s cost %d ms', fn.name || 'λ', duration)
  return duration
}

const f = () => console.log('π = %d', calc(1e5))

const d = await profile(f)
await profile(() => sleep(d))