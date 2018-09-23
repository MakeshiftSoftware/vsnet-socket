/* eslint-disable prefer-arrow-callback */
const http = require('http');
const WebSocket = require('uws');
const url = require('url');
const express = require('express');
const qs = require('query-string');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');

function noop() {}

const DEFAULT_PING_INTERVAL = 30000;
const DEFAULT_CHANNEL = 'global';

class VsSocket {
  /**
   * Initialize socket server
   *
   * @param {Object} options - Server options
   */
  constructor(options) {
    const {
      port,
      secret,
      pubsub,
      store,
      pingInterval = DEFAULT_PING_INTERVAL,
      logger
    } = options;

    this.port = port;
    this.secret = secret;
    this.pingInterval = pingInterval;
    this.logger = logger;

    this.logger.info('[socket] Initializing socket server');

    this.users = {};
    this.handlers = {};

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
    this.logger.info('[socket] Initializing express app');

    const server = this;

    const app = express();

    app.get('/healthz', async function(req, res) {
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
    this.logger.info('[socket] Initializing express server');

    const server = http.createServer(this.app);

    this.wss = new WebSocket.Server({
      server: server,
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
      this.logger.info('[socket] Redis returned a READONLY error, reconnecting');

      // return 2 to reconnect and resend the failed command
      return 2;
    }
  }

  /**
   * Initialize store connection
   *
   * @param {Object} config - Store config
   */
  initStore(config) {
    this.logger.info('[socket] Initializing redis store');

    const options = {
      lazyConnect: true,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: true,
      retryStrategy: this.redisRetryStrategy,
      reconnectOnError: this.redisReconnectStrategy
    };

    if (config.password) {
      options.password = config.password;
    }

    this.store = new Redis(config.url, options);

    function onReady() {
      this.logger.info('[socket] Redis store ready to receive commands');
    }

    function onError() {
      this.logger.info('[socket] Error connecting to redis store, retrying');
    }

    this.store.on('ready', onReady);
    this.store.on('error', onError);

    this.store.connect().catch(function() {
      this.logger.info('[socket] Initial redis store connection attempt failed');
    });
  }

  /**
   * Initialize pubsub connection
   *
   * @param {Object} config - Pubsub config
   */
  initPubsub(config) {
    this.logger.info('[socket] Initializing redis pubsub');

    const options = {
      lazyConnect: true,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: true,
      retryStrategy: this.redisRetryStrategy,
      reconnectOnError: this.redisReconnectStrategy
    };

    if (config.password) {
      options.password = config.password;
    }

    this.pub = new Redis(config.url, options);
    this.sub = new Redis(config.url, options);

    const channels = config.channels || [DEFAULT_CHANNEL];

    for (let i = 0; i < channels.length; ++i) {
      this.sub.subscribe(channels[i]);
    }

    function onMessage(channel, message) {
      this.logger.info('[socket] Received pubsub message: ' + message);

      const m = this.parseMessage(message);

      if (m && m.data && m.recipient) {
        this.logger.info('[socket] Publishing message');

        if (Array.isArray(m.recipient)) {
          this.relayMulti(m.data, m.recipient);
        } else {
          this.relaySingle(m.data, m.recipient);
        }
      }
    }

    function onReady() {
      this.logger.info('[socket] Redis pubsub ready to receive commands');
    }

    function onError() {
      this.logger.info('[socket] Error connecting to redis pubsub, retrying');
    }

    this.sub.on('message', onMessage);
    this.sub.on('ready', onReady);
    this.sub.on('error', onError);
    this.pub.on('ready', onReady);
    this.pub.on('error', onError);

    this.sub.connect().catch(function() {
      this.logger.info('[socket] Initial redis subscribe connection attempt failed');
    });

    this.pub.connect().catch(function() {
      this.logger.info('[socket] Initial redis publish connection attempt failed');
    });
  }

  /**
   * Start server
   * Start heartbeat interval
   *
   * @param {Function} cb - Callback function
   */
  start(cb) {
    this.logger.info('[socket] Starting socket server');

    const server = this;

    this.server.listen(this.port, function() {
      this.logger.info('[socket] Socket server started on port ' + server.port);

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
    this.logger.info('[socket] Stopping socket server');

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
  onClientConnected(socket) {
    const server = this;
    const { user } = socket.upgradeReq;

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

    if (server.handlers.connected) {
      server.handlers.connected(socket);
    }

    this.logger.info('[socket] New socket connection with id: ' + user.id);
  }

  /**
   * Client disconnected handler
   *
   * @param {Object} socket - Socket object
   */
  onClientDisconnected(socket) {
    const server = this;

    delete this.users[socket.id];

    if (server.handlers.disconnected) {
      server.handlers.disconnected(socket);
    }

    this.logger.info('[socket] Socket disconnected: ' + socket.id);
  }

  /**
   * Register callback function for an event
   *
   * @param {String} event - Event name
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    this.handlers[event] = callback;
  }

  /**
   * Ping sockets to check if they are alive
   * TODO: cleanup disconnected sockets
   */
  ping() {
    const server = this;

    for (let i = 0; i < server.wss.clients.length; ++i) {
      const socket = server.wss.clients[i];

      if (socket.isAlive === false) {
        this.logger.info('[socket] Cleaning up dead socket: ' + socket.id);

        delete server.users[socket.id];
        return socket.terminate();
      }

      socket.isAlive = false;
      socket.ping(noop);
    }
  }

  /**
   * Message received handler
   *
   * @param {String} message - Message json
   * @param {Object} socket - Socket object
   */
  onMessageReceived(message, socket) {
    this.logger.info('[socket] Received socket data: ' + message);

    const m = this.parseMessage(message);

    if (m) {
      const handler = this.handlers[m.data.type];

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
      this.logger.error('[socket] Unable to parse message: ' + err.message);
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
   * @param {(String|Object)} message - The message string or object
   * @param {Object} socket - The socket object
   */
  sendMessage(message, socket) {
    if (typeof message === 'object') {
      socket.send(JSON.stringify(message));
    } else {
      socket.send(message);
    }
  }

  /**
   * Send message to a single user by user id
   *
   * @param {Object} data - Message data
   * @param {String} id - User id
   */
  relaySingle(data, id) {
    const socket = this.users[id];

    if (socket) {
      this.logger.info('[socket] Recipient socket found, sending message');

      this.sendMessage(data, socket);
    }
  }

  /**
   * Send message to multiple users using an array of user ids
   *
   * @param {Object} data - Message data
   * @param {Array} ids - Array of user ids
   */
  relayMulti(data, ids) {
    for (let i = 0; i < ids.length; ++i) {
      const socket = this.users[ids[i]];

      if (socket) {
        this.logger.info('[socket] Recipient socket found, sending message');

        this.sendMessage(data, socket);
      }
    }
  }

  /**
   * Define custom redis command
   *
   * @param {String} name - Command name
   * @param {String} script - Lua script text
   */
  defineCommand(name, script) {
    this.logger.info('[socket] Defining custom redis command: ' + name);

    this.store.defineCommand(name, {
      lua: script,
      numberOfKeys: 0
    });
  }

  /**
   * Define additional actions on client connected event
   *
   * @param {Function} cb - Callback function
   */
  onConnect(cb) {
    this.handlers.connected = cb;
  }

  /**
   * Define additional actions on client disconnected event
   *
   * @param {Function} cb - Callback function
   */
  onDisconnect(cb) {
    this.handlers.disconnected = cb;
  }
}

module.exports = VsSocket;
