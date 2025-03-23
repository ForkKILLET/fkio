const arr = [ 1, 2, 3 ]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const promises = []

for (const val of arr) {
    promises.push(
        sleep(val * 1000).then(() => console.log('%o', val))
    )
}

await Promise.all(promises)