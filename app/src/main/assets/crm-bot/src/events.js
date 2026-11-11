const EventEmitter = require('events');
class BotEventEmitter extends EventEmitter {}
module.exports = new BotEventEmitter();