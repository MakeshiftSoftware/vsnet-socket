const url = require('url');
const WebSocket = require('ws');
const Redis = require('ioredis');
const qs = require('query-string');
const jwt = require('jsonwebtoken');

function noop() {}

/**
 * Class representing a WebSocket server.
 */
class VsnetSocket {
  /**
   * Create a `VsSocketServer` instance.
   *
   * @param {Object} options Configuration options
   * @param {Object} options.extensions Optional modules to add to server instance
   * @param {Boolean} options.trackUsers Specifies whether or not to track users
   * @param {Number} options.maxPayload The maximum allowed message size
   * @param {http.Server} options.server A pre-created HTTP/S server to use
   * @param {Object} options.pubsub A pubsub configuration to enable publish/subscribe
   * @param {String} options.pubsub.url Redis pubsub url to connect to
   * @param {String} options.pubsub.channel Redis channel to subscribe to
   * @param {String} options.pubsub.password Optional password for connecting to Redis
   * @param {Function} options.verifyClient An hook to reject connections
   * @param {String} options.secret Optional secret used to verify clients
   */
  constructor(options) {
    options = Object.assign(
      {
        extensions: null,
        trackUsers: true,
        pubsub: null,
        secret: null,
        pingInterval: 30000,
      },
      options,
    );

    if (!options.server) {
      throw new TypeError('"server" option must be specified');
    }

    if (options.pubsub && (!options.pubsub.url || !options.pubsub.channel)) {
      throw new TypeError(
        'if pubsub option if specified, "pubsub.url" and "pubsub.channel" must be provided',
      );
    }

    //
    // Optionally add extensions to instance.
    //
    if (options.extensions) {
      Object.keys(options.extensions).forEach(key => {
        this[key] = options.extensions[key];
      });
    }

    //
    // Optionally initialize pubsub.
    //
    if (options.pubsub) {
      //
      // Initialize pubsub and subscribe to channel.
      //
      this.pub = new Redis(options.pubsub.url, { password: options.pubsub.password });
      this.sub = new Redis(options.pubsub.url, { password: options.pubsub.password });
      this.sub.subscribe(options.pubsub.channel);

      //
      // Attach pubsub message handler.
      //
      this.sub.on('message', (channel, message) => {
        this.relayMessage(message);
      });
    }

    //
    // Initialize message received handler.
    //
    this.onMessageReceived = options.pubsub ? this.publishMessage : this.relayMessage;

    //
    // Initialize ws server options.
    //
    const wssOptions = {
      server: options.server,
      maxPayload: options.maxPayload,
    };

    //
    // Optionally initialize ws client verification.
    //
    if (options.secret) {
      wssOptions.verifyClient = (info, cb) => {
        const token = qs.parse(url.URL(info.req.url).search).token;

        if (!token) {
          return cb(false);
        }

        jwt.verify(token, options.secret, (err, decoded) => {
          if (err) {
            cb(false);
          } else {
            info.req.user = decoded;
            cb(true);
          }
        });
      };
    }

    //
    // Initialize ws server.
    //
    this.wss = new WebSocket.Server(wssOptions);

    //
    // Attach client connected handler.
    //
    this.wss.on('connection', this.onClientConnected);

    //
    // Optionally initialize users.
    //
    if (options.trackUsers) {
      this.users = new Map();
    }

    //
    // Start socket keep alive interval.
    //
    setInterval(() => {
      for (let i = 0, length = this.wss.clients.length; i < length; ++i) {
        const socket = this.wss.clients[i];

        if (socket.isAlive === false) {
          if (options.trackUsers) {
            this.users.delete(socket.id);
          }
        } else {
          socket.isAlive = false;
          socket.ping(noop);
        }
      }
    }, options.pingInterval);
  }

  /**
   * Client connected handler
   *
   * @param {Object} socket - Socket object
   * @param {Object} req - Request object
   */
  onClientConnected(socket, req) {
    socket.id = req.user.id;
    socket.isAlive = true;

    if (this.options.trackUsers) {
      this.users.set(socket.id, socket);
    }

    socket.on('message', this.onMessageReceived);

    socket.on('close', () => {
      if (this.options.trackUsers) {
        this.users.delete(socket.id);
      }
    });

    socket.on('pong', () => {
      socket.isAlive = true;
    });
  }

  /**
   * Message received handler
   *
   * @param {String} message - Message data
   */
  publishMessage(message) {
    this.pub.publish(this.options.pubsub.channel, message);
  }

  /**
   * Send message to a user or list of users
   *
   * @param {String} message data - Message object
   */
  relayMessage(message) {
    // @TODO: new protocol for determining recipients and message content
    const to = 1;
    const content = 'hi';

    if (Array.isArray(to)) {
      to.forEach(r => {
        if (this.users[r]) {
          this.users[r].send(content);
        }
      });
    } else if (this.users[to]) {
      this.users[to].send(content);
    }
  }
}

module.exports = VsnetSocket;
