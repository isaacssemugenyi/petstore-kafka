require('dotenv').config() // Will load .env into process.env
const express = require('express')
const path = require('path')
const cors = require('cors')
const app = express()
const bodyParser = require('body-parser')
const uuid = require('uuid')
const morgan = require('morgan')
const { Kafka, logLevel } = require('kafkajs')
const { dbOpen, dbPut, dbGet, dbGetAll, dbQuery } = require('../lib').db

// Configs
const BROKERS = process.env.BROKERS || ['localhost:9092']
const CLIENT_ID = 'adoptions'

// ---------------------------------------------------------------
// DB Sink
dbOpen('./adoptions.db')

// ---------------------------------------------------------------
// Kafka
const kafka = new Kafka({
  logLevel: logLevel.INFO,
  brokers: BROKERS,
  clientId: CLIENT_ID,
  retry: {
    initialRetryTime: 1000,
    retries: 16
  }
})

const consumers = []
const producer = kafka.producer()
producer.connect()


// Consume kafka
// async function subscribeToAdoptionsRequested () {
//   const consumerGroup = 'pets-statusChanged-sink'
//   try {
//     const consumer = kafka.consumer({ groupId: consumerGroup})
//     await consumer.connect()
//     consumers.push(consumer)
//     await consumer.subscribe({ topic: 'pets.statusChanged', fromBeginning: true })
//     await consumer.run({
//       autoCommit: false,
//       eachMessage: async ({ topic, partition, message }) => {
//         const prefix = `${topic}[${partition} | ${message.offset}] / ${message.timestamp}`
//         console.log(`- ${prefix} ${message.key}#${message.value}`)
//         const {id, status} = JSON.parse(message.value)

//         // Save to DB with new status
//         const pet = dbGet(id)
//         dbPut(id, {...pet, status})
//         dbPut(`${consumerGroup}.offset`, message.offset + 1)
//         consumer.commitOffsets([{topic, partition, offset: message.offset + 1}])
//       },
//     })
//     const dbOffset = dbGet(`${consumerGroup}.offset`) || -1
//     if(dbOffset < 0) {
//       console.log(`${consumerGroup} - Seeking to ${dbOffset}`)
//       await consumer.seek({ topic: 'pets.added', partition: 0, offset: dbOffset })
//     } else {
//       console.log(`${consumerGroup} - Not Seeking, leaving default offset from Kafka`)
//     }
//   } catch(e) {
//     console.error(`[${consumerGroup}] ${e.message}`, e)   
//   }
// }

// subscribeToPetsStatusChanged()


// ---------------------------------------------------------------
// Rest
app.use(morgan('combined'))
app.use(cors())
app.use(bodyParser.json())

app.get('/api/adoptions', (req, res) => {
  const { location, status } = req.query
  if(!location && !status) {
    return res.json(dbGetAll())
  }

  return res.json(dbQuery({ location, status }, { caseInsensitive: true }))
})

app.post('/api/adoptions', (req, res) => {
  const adoption = req.body
  adoption.id = adoption.id || uuid.v4()

  producer.send({
    topic: 'pets.added',
    messages: [
      { value: JSON.stringify(adoption) },
    ],
  })

  res.status(201).send(adoption)
})

app.patch('/api/adoptions/:id', (req, res) => {
  const adoptions = dbGet(req.params.id)
  const { status } = req.body
  if(!adoptions)
    res.status(400).json({
      message: 'Adoption not found, cannot patch.'
    })

  const updatedAdoption = {...adoption, status }

  producer.send({
    topic: 'adoptions.statusChanged',
    messages: [
      { value: JSON.stringify(updatedAdoption) },
    ],
  })

  res.status(200).send(updatedAdoption)
})

// // SPA
// app.use(express.static(path.resolve(__dirname, process.env.SPA_PATH || '../web-ui/build')))


// ---------------------------------------------------------------------------------------
// Boring stuff follows...
// ---------------------------------------------------------------------------------------

// Start server and handle logic around graceful exit
const server = app.listen(process.env.NODE_PORT || 3200, () => {
  console.log('Server listening on http://' + server.address().address + ':' + server.address().port)
})
// Keep track of connections to kill 'em off later.
let connections = []
server.on('connection', connection => {
  connections.push(connection);
  connection.on('close', () => connections = connections.filter(curr => curr !== connection));
});

// Exit gracefully
const errorTypes = ['unhandledRejection', 'uncaughtException']
const signalTraps = ['SIGTERM', 'SIGINT', 'SIGUSR2']
errorTypes.forEach(type => {
  process.on(type, async e => {
    try {
      console.log(`process.on ${type}`)
      console.error(e)
      await shutdown()
    } catch (_) {
      process.exit(1)
    }
  })
})


signalTraps.forEach(type => {
  process.once(type, async () => {
    try {
      await shutdown()
    } finally {
      process.kill(process.pid, type)
    }
  })
})


async function shutdown() {
  await Promise.all(consumers.map(consumer => consumer.disconnect()))

  server.close(() => {
    console.log('Closed out remaining connections');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 5000);

  connections.forEach(curr => curr.end());
  setTimeout(() => connections.forEach(curr => curr.destroy()), 5000);
}

