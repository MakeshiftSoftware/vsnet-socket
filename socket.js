/* eslint-disable prefer-arrow-callback */
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const express = require('express');
const qs = require('query-string');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const logger = require('vsnet-logger');

function noop() {}

const DEFAULT_PING_INTERVAL = 30000;
const DEFAULT_CHANNEL = 'global';

class VsSocket {
  /**
   * Initialize socket server
   *
   * @param {Object} options - Server options
   */
  constructor({
    port,
    secret,
    pubsub,
    store,
    onConnect,
    onDisconnect,
    events = {},
    pingInterval = DEFAULT_PING_INTERVAL
  }) {
    logger.info('[socket] Initializing socket server');

    /* Initialize server attributes */
    this.port = port;
    this.secret = secret;
    this.pingInterval = pingInterval;
    this.events = events;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.users = {};

    if (store) {
      this.initStore(store);
    }

    if (pubsub) {
      this.initPubsub(pubsub);
    }

    this.initApp();
    this.initServer();
  }

  /**
   * Initialize app and routes
   */
  initApp() {
    logger.info('[socket] Initializing express app');

    const server = this;
    const app = express();

    app.get('/healthz', async (req, res) => {
      try {
        // check if redis is still responding
        const actions = [
          server.sub.ping(),
          server.pub.ping()
        ];

        if (server.store) {
          actions.push(server.store.ping());
        }

        await Promise.all(actions);

        res.sendStatus(200);
      } catch (err) {
        res.sendStatus(400);
      }
    });

    this.app = app;
  }

  /**
   * Initialize http server and websocket server
   */
  initServer() {
    logger.info('[socket] Initializing server');

    const server = http.createServer(this.app);

    this.wss = new WebSocket.Server({
      server,
      verifyClient: this.verifyClient(this.secret)
    });

    this.wss.on('connection', this.onClientConnected.bind(this));
    this.server = server;
  }

  /**
   * Strategy for reattempting to connect to redis
   *
   * @param {Integer} times - The current attempt number
   */
  redisRetryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }

  /**
   * Strategy for reconnecting to redis after an error
   *
   * @param {Error} err - The error thrown by redis
   */
  redisReconnectStrategy(err) {
    const targetError = 'READONLY';

    if (err.message.slice(0, targetError.length) === targetError) {
      // When a slave is promoted, we might get temporary errors when
      // attempting to write against a read only slave. Attempt to
      // reconnect if this happens
      logger.info('[socket] Redis returned a READONLY error, reconnecting');

      // return 2 to reconnect and resend the failed command
      return 2;
    }
  }

  /**
   * Initialize store connection
   *
   * @param {Object} config - Store config
   */
  initStore({ url, password }) {
    logger.info('[socket] Initializing redis store');

    const options = {
      lazyConnect: true,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: true,
      retryStrategy: this.redisRetryStrategy,
      reconnectOnError: this.redisReconnectStrategy
    };

    if (password) {
      options.password = password;
    }

    this.store = new Redis(url, options);

    function onReady() {
      logger.info('[socket] Redis store ready to receive commands');
    }

    function onError() {
      logger.info('[socket] Error connecting to redis store, retrying');
    }

    this.store.on('ready', onReady);
    this.store.on('error', onError);

    this.store.connect().catch(function() {
      logger.info('[socket] Initial redis store connection attempt failed');
    });
  }

  /**
   * Initialize pubsub connection
   *
   * @param {Object} config - Pubsub config
   */
  initPubsub({
    url,
    password,
    channels = [DEFAULT_CHANNEL]
  }) {
    logger.info('[socket] Initializing redis pubsub');

    const options = {
      lazyConnect: true,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: true,
      retryStrategy: this.redisRetryStrategy,
      reconnectOnError: this.redisReconnectStrategy
    };

    if (password) {
      options.password = password;
    }

    this.pub = new Redis(url, options);
    this.sub = new Redis(url, options);

    channels.forEach((channel) => (
      this.sub.subscribe(channel)
    ));

    function onMessage(channel, message) {
      logger.info('[socket] Received pubsub message: ' + message);

      const m = this.parseMessage(message);

      if (m && m.data && m.recipient) {
        logger.info('[socket] Relaying message');

        this.relayMessage(m);
      }
    }

    function onReady() {
      logger.info('[socket] Redis pubsub ready to receive commands');
    }

    function onError() {
      logger.info('[socket] Error connecting to redis pubsub, retrying');
    }

    this.sub.on('message', onMessage);
    this.sub.on('ready', onReady);
    this.sub.on('error', onError);
    this.pub.on('ready', onReady);
    this.pub.on('error', onError);

    this.sub.connect().catch(function() {
      logger.info('[socket] Initial redis subscribe connection attempt failed');
    });

    this.pub.connect().catch(function() {
      logger.info('[socket] Initial redis publish connection attempt failed');
    });
  }

  /**
   * Start server
   * Start heartbeat interval
   *
   * @param {Function} cb - Callback function
   */
  start(cb) {
    logger.info('[socket] Starting socket server');

    const server = this;

    this.server.listen(this.port, function() {
      logger.info('[socket] Socket server started on port ' + server.port);

      setInterval(server.ping.bind(server), server.pingInterval);

      if (cb) {
        cb();
      }
    });
  }

  /**
   * Stop server
   * Close redis connections
   */
  stop() {
    logger.info('[socket] Stopping socket server');

    const actions = [];

    if (this.pub) {
      actions.push(this.pub.close());
    }

    if (this.sub) {
      actions.push(this.sub.unsubscribe());
      actions.push(this.sub.close());
    }

    if (this.store) {
      actions.push(this.store.close());
    }

    return Promise.all(actions);
  }

  /**
   * Authenticate connection request using jwt
   *
   * @param {String} secret - Server secret
   */
  verifyClient(secret) {
    if (!secret) {
      return;
    }

    return function(info, cb) {
      const token = qs.parse(url.parse(info.req.url).search).token;

      if (!token) {
        return cb(false);
      }

      jwt.verify(token, secret, function(err, decoded) {
        if (err) {
          cb(false);
        } else {
          info.req.user = decoded;
          cb(true);
        }
      });
    };
  }

  /**
   * Client connected handler
   *
   * @param {Object} socket - Socket object
   */
  onClientConnected(socket, req) {
    const server = this;
    const { user } = req;

    if (!user || !user.id) {
      return socket.terminate();
    }

    socket.id = user.id;
    server.users[user.id] = socket;
    socket.isAlive = true;

    socket.on('message', function(message) {
      server.onMessageReceived(message, socket);
    });

    socket.on('close', function() {
      server.onClientDisconnected(socket);
    });

    socket.on('pong', function() {
      socket.isAlive = true;
    });

    if (server.onConnected) {
      server.onConnected(socket);
    }

    logger.info('[socket] New socket connection with id: ' + user.id);
  }

  /**
   * Client disconnected handler
   *
   * @param {Object} socket - Socket object
   */
  onClientDisconnected(socket) {
    delete this.users[socket.id];

    if (this.onDisconnected) {
      this.onDisconnected(socket);
    }

    logger.info('[socket] Socket disconnected: ' + socket.id);
  }

  /**
   * Ping sockets to check if they are alive
   * TODO: cleanup disconnected sockets
   */
  ping() {
    this.wss.clients.forEach((socket) => {
      if (socket.isAlive === false) {
        logger.info('[socket] Cleaning up dead socket: ' + socket.id);

        delete this.users[socket.id];
        return socket.terminate();
      }

      socket.isAlive = false;
      socket.ping(noop);
    });
  }

  /**
   * Message received handler
   *
   * @param {String} message - Message json
   * @param {Object} socket - Socket object
   */
  onMessageReceived(message, socket) {
    logger.info('[socket] Received socket data: ' + message);

    const m = this.parseMessage(message);

    if (m) {
      const handler = this.events[m.data.type];

      if (handler) {
        handler(m, socket);
      }
    }
  }

  /**
   * Parse incoming socket message
   *
   * @param {String} message - Socket message
   */
  parseMessage(message) {
    try {
      const m = JSON.parse(message);

      return {
        data: m.data,
        recipient: m.recipient
      };
    } catch (err) {
      logger.error('[socket] Unable to parse incoming message');
    }
  }

  /**
   * Publish message
   *
   * @param {Object} m - Message object
   * @param {String} channel - Channel to publish message to
   */
  publishMessage(m, channel) {
    this.pubsub.publish(channel, JSON.stringify(m));
  }

  /**
   * Send message to user
   *
   * @param {String|Object} message - The message data
   * @param {Object} socket - The recipient socket
   */
  sendMessage(data, socket) {
    logger.info('[socket] Sending message to user: ' + socket.id);

    if (typeof data === 'object') {
      socket.send(JSON.stringify(data));
    } else {
      socket.send(data);
    }
  }

  /**
   * Message recipient found handler
   *
   * @param {Object|String} data - Message data to be sent
   * @param {Object} socket - Recipient's socket object
   */
  onRecipientFound(data, socket) {
    logger.info('[socket] Recipient socket found, sending message');

    this.sendMessage(data, socket);
  }

  /**
   * Send message to a user or list of users
   *
   * @param {Object} m - Message object
   */
  relayMessage(m) {
    const { data, recipient } = m;

    if (data === undefined || recipient === undefined) {
      logger.info('[socket] Invalid message: missing data or recipient property');
    }

    if (Array.isArray(recipient)) {
      recipient.forEach((r) => {
        if (this.users[r]) {
          this.onRecipientFound(data, this.users[r]);
        }
      });
    } else if (this.users[recipient]) {
      this.onRecipientFound(data, this.users[recipient]);
    }
  }

  /**
   * Define custom redis command
   *
   * @param {String} name - Command name
   * @param {String} script - Lua script text
   */
  defineCommand(name, script) {
    logger.info('[socket] Defining custom redis command: ' + name);

    this.store.defineCommand(name, {
      lua: script,
      numberOfKeys: 0
    });
  }
}

module.exports = VsSocket;
