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
