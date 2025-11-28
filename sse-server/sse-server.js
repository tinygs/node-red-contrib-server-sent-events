/**
 *
 * @param {string | Object} data
 * @returns
 */
function _serializeData(data) {
	return typeof data === 'string' ? data : JSON.stringify(data);
}

// Module-level debug switch: set environment variable `SSE_SERVER_DEBUG=1`
// to force debug messages from this module to appear even when global
// Node-RED log level is `info`. When enabled, messages are emitted with
// `RED.log.info` so they are visible under the global `info` level.
const MODULE_DEBUG = (process.env.SSE_SERVER_DEBUG === '1' || process.env.SSE_SERVER_DEBUG === 'true');

function moduleDebug(RED, ...args) {
    try {
        const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        if (MODULE_DEBUG) {
            // Force visibility at 'info' level while keeping a clear prefix
            RED.log.info(`[sse-server-debug] ${message}`);
        } else {
            // Preserve original debug behavior
            RED.log.debug(message);
        }
    } catch {
        // Avoid throwing from logging
    }
}

/**
 * Removes all event listeners from a subscriber to prevent memory leaks.
 * @param {Object} subscriber - The subscriber object with handlers
 * @param {Object} RED - The Node-RED runtime for logging
 */
function cleanupSubscriberListeners(subscriber, RED) {
    if (!subscriber.handlers) return;
    
    try {
        if (subscriber.rawSocket) {
            subscriber.rawSocket.removeListener('close', subscriber.handlers.socketClose);
            subscriber.rawSocket.removeListener('error', subscriber.handlers.socketError);
            subscriber.rawSocket.removeListener('end', subscriber.handlers.socketEnd);
        }
        if (subscriber.rawReq) {
            subscriber.rawReq.removeListener('close', subscriber.handlers.reqClose);
            subscriber.rawReq.removeListener('aborted', subscriber.handlers.reqAborted);
        }
        if (subscriber.rawRes) {
            subscriber.rawRes.removeListener('close', subscriber.handlers.resClose);
            subscriber.rawRes.removeListener('finish', subscriber.handlers.resFinish);
        }
    } catch (e) {
        if (RED) {
            RED.log.warn(`Error removing listeners: ${e.message}`);
        }
    }
}

/**
 * Updates the status of a given node with a blue circle and the number of connected clients.
 *
 * @param {Object} node - The node to update status for.
 */
function updateNodeStatus(node, type) {
	node.status({
		fill: type === 'success' ? 'green' : 'red',
		shape: 'dot',
		text: `${node.subscribers.length} client(s) connected`,
	});
}

/**
 * Registers a new subscriber for a server-sent event (SSE) stream. This function
 * writes an opening header and message to the client and adds the client to the
 * list of subscribers for the given node.
 *
 * @param {Object} RED - the instance of the Node-RED runtime
 * @param {Object} node - the node instance in the Node-RED flow
 * @param {Object} msg - the message object containing information about the request
 * @return {void}
 */
function registerSubscriber(RED, node, msg) {
    moduleDebug(RED, 'Client connected');
    
    // Check if this socket is already registered (avoid duplicates)
    const incomingSocket = msg.res._res.req.socket;
    const existingSubscriber = node.subscribers.find(sub => sub.rawSocket === incomingSocket);
    if (existingSubscriber) {
        moduleDebug(RED, `Socket already registered for subscriber ${existingSubscriber.id}, skipping registration`);
    }
    
    // Write the opening header
    msg.res._res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    // Write the initial opening message
    msg.res._res.write('event: open\n');
    msg.res._res.write(
        `data: ${_serializeData(msg.payload || 'Connection opened')}\n`,
    );
    msg.res._res.write(`id: ${msg._msgid}\n\n`);
    if (msg.res._res.flush) msg.res._res.flush();

    // Store minimal references to avoid memory leaks
    const subscriberId = msg._msgid;
    const responseSocket = msg.res;
    const clientIP = msg.req.headers["x-forwarded-for"] || msg.res._res.req.socket.remoteAddress;
    // Store references for close event detection
    // See: https://github.com/nestjs/nest/issues/12670
    const socket = msg.res._res.req.socket;
    const res = msg.res._res;
    const req = msg.res._res.req;

    // Close a SSE connection when client disconnects
    const closeHandler = (source) => {
        return () => {
            moduleDebug(RED, `closeHandler called from: ${source} for subscriber ${subscriberId}`);
            
            // Prevent multiple calls
            if (closeHandler._called) {
                moduleDebug(RED, `closeHandler already called, skipping`);
                return;
            }
            closeHandler._called = true;
            
            // Find and remove subscriber by ID to avoid keeping msg reference
            const subscriberIndex = node.subscribers.findIndex(sub => sub.id === subscriberId);
            if (subscriberIndex !== -1) {
                const subscriber = node.subscribers[subscriberIndex];
                // Clean up the connection
                try {
                    subscriber.socket._res.write('event: close\n');
                    subscriber.socket._res.write(`data: The connection was closed by the client.\n`);
                    subscriber.socket._res.write(`id: ${subscriberId}\n\n`);
                    if (subscriber.socket._res.flush) subscriber.socket._res.flush();
                    subscriber.socket._res.end();
                } catch (e) {
                    RED.log.warn(`Error writing close event: ${e.message}`);
                }
                
                // Remove subscriber from array
                node.subscribers.splice(subscriberIndex, 1);
                
                // Emit disconnect message (include ip directly since req won't be available)
                node.send({
                    _msgid: subscriberId,
                    payload: {
                        event: 'disconnect',
                        subscribers: node.subscribers.length,
                        ip: clientIP,
                    },
                    // Provide a minimal req-like object for compatibility with flows that check req.headers
                    req: {
                        headers: {
                            'x-forwarded-for': clientIP
                        }
                    }
                });
            }
            updateNodeStatus(node, 'success');
            // Remove all listeners to avoid memory leaks
            socket.removeListener('close', socketCloseHandler);
            socket.removeListener('error', socketErrorHandler);
            socket.removeListener('end', socketEndHandler);
            req.removeListener('close', reqCloseHandler);
            req.removeListener('aborted', reqAbortedHandler);
            res.removeListener('close', resCloseHandler);
            res.removeListener('finish', resFinishHandler);
        };
    };
    
    // Create named handlers for proper removal
    const socketCloseHandler = closeHandler('socket.close');
    const socketErrorHandler = closeHandler('socket.error');
    const socketEndHandler = closeHandler('socket.end');
    const reqCloseHandler = closeHandler('req.close');
    const reqAbortedHandler = closeHandler('req.aborted');
    const resCloseHandler = closeHandler('res.close');
    const resFinishHandler = closeHandler('res.finish');
    
    // Listen on multiple events for maximum compatibility
    // socket.on('close') - for abrupt disconnections at TCP level
    socket.on('close', socketCloseHandler);
    // socket.on('error') - for socket errors
    socket.on('error', socketErrorHandler);
    // socket.on('end') - when the other end signals FIN
    socket.on('end', socketEndHandler);
    // req.on('close') - standard HTTP request close
    req.on('close', reqCloseHandler);
    // req.on('aborted') - request was aborted by client (deprecated but still works)
    req.on('aborted', reqAbortedHandler);
    // res.on('close') - response stream closed (most reliable for SSE)
    res.on('close', resCloseHandler);
    // res.on('finish') - response finished writing
    res.on('finish', resFinishHandler);
    
    moduleDebug(RED, `Registered close handlers for subscriber ${subscriberId}`);

    // Prevent adding the same subscriber twice
    if (!node.subscribers.some((sub) => sub.id === subscriberId) && ! existingSubscriber) {
        node.subscribers.push({
            id: subscriberId,
            socket: responseSocket,
            rawSocket: socket, // Store raw socket reference for cleanup
            rawRes: res, // Store raw response for cleanup
            rawReq: req, // Store raw request for cleanup
            handlers: { // Store all handlers for proper cleanup
                socketClose: socketCloseHandler,
                socketError: socketErrorHandler,
                socketEnd: socketEndHandler,
                reqClose: reqCloseHandler,
                reqAborted: reqAbortedHandler,
                resClose: resCloseHandler,
                resFinish: resFinishHandler,
            },
        });
    }
    updateNodeStatus(node, 'success');

    // Emit output message on client connect
    msg.payload = {
        event: 'connect',
        subscribers: node.subscribers.length,
        ip: clientIP,
    };
    node.send(msg);
}

/**
 * Unregisters a subscriber by removing it from the list of subscribers and
 * sending a closing message to the client.
 *
 * @param {Object} node - The node object containing the list of subscribers.
 * @param {Object} msg - The message object containing the id of the subscriber to remove and the response object to write to.
 * @return {void}
 */
// function unregisterSubscriber(node, msg) {
//     const subscriberId = msg._msgid;
//     const subscriberIndex = node.subscribers.findIndex(sub => sub.id === subscriberId);
    
//     if (subscriberIndex === -1) {
//         RED.log.warn(`Subscriber ${subscriberId} not found for unregistration`);
//         return;
//     }
    
//     const subscriber = node.subscribers[subscriberIndex];
    
//     // Write out closing message to client
//     try {
//         msg.res._res.write('event: close\n');
//         msg.res._res.write(`data: The connection was closed by the server.\n`);
//         msg.res._res.write(`id: ${subscriberId}\n\n`);
//         if (msg.res._res.flush) msg.res._res.flush();
//     } catch (e) {
//         RED.log.warn(`Error writing close event: ${e.message}`);
//     }

//     // Clean up event listeners to prevent memory leak
//     cleanupSubscriberListeners(subscriber, RED);

//     // Remove the subscriber from the list
//     node.subscribers.splice(subscriberIndex, 1);
    
//     try {
//         msg.res._res.end();
//     } catch (e) {
//         RED.log.warn(`Error closing response: ${e.message}`);
//     }
    
//     // Emit output message on client disconnect
//     msg.payload = {
//         event: 'disconnect',
//         subscribers: node.subscribers.length,
//         ip: msg.res._res.req.socket.remoteAddress,
//     };
//     node.send(msg);
// }

/**
 * Sends server event data to all subscribers.
 *
 * @param {object} node - The node object containing subscribers and event data.
 * @param {object} msg - The message object containing topic and payload.
 */
function handleServerEvent(RED, node, msg) {
	// Extract data immediately to avoid retaining msg reference
	const event = `${node.event || msg.topic || 'message'}`;
	const data = `${_serializeData(node.data || msg.payload)}`;
	const messageId = msg._msgid;
	
	// Clear msg reference early to help GC
	msg = null;
	
    moduleDebug(RED, `Sent event: ${event}`);
    moduleDebug(RED, `Data: ${data}`);
    // Debug: print number of subscribers before sending
    moduleDebug(RED, `Subscribers before send: ${node.subscribers.length}`);
	let subscriberIndex = 0;
	node.subscribers = node.subscribers.filter((subscriber) => {
		subscriberIndex++;
		try {
			subscriber.socket._res.write(`event: ${event}\n`);
			subscriber.socket._res.write(`data: ${data}\n`);
			subscriber.socket._res.write(`id: ${messageId}\n\n`);
			if (subscriber.socket._res.flush) subscriber.socket._res.flush();
            moduleDebug(RED, `Data sent to subscriber #${subscriberIndex} (id: ${subscriber.id})`);
			return true;
		} catch (e) {
			RED.log.warn(
                `Error sending event to subscriber ${subscriber.id}: ${e.message}`,
            );
			// Clean up event listeners to prevent memory leak
			cleanupSubscriberListeners(subscriber, RED);
			try {
				subscriber.socket._res.end();
			} catch (endErr) {
    			RED.log.warn(
                    `Error ending subscriber response: ${endErr.message}`,
                );
			}
			return false; // Remove broken subscriber
		}
	});
}

module.exports = function (RED) {
	/**
	 * Creates a new SSE (Server-Sent Events) server node with the specified configuration.
	 *
	 * @param {Object} config - the configuration object for the node
	 * @param {string} config.event - the name of the event to emit to the client
	 * @param {string} config.data - the data to send to the client with the event
	 * @return {void}
	 */
	function CreateSseServerNode(config) {
		RED.nodes.createNode(this, config);
		this.subscribers = [];
		this.event = config.event;
		this.data = config.data;

		/**@ts-ignore */
		this.on('input', (msg, send, done) => {
			try {
				if (msg.res) {
					registerSubscriber(RED, this, msg);
				} else {
					handleServerEvent(RED, this, msg);
				}
			} catch (error) {
				RED.log.error(error);
				updateNodeStatus(this, 'error');
			} finally {
				if (done && typeof done === 'function') done();
			}
        });
        
        this.on('close', (removed, done) => {
            this.subscribers.forEach((subscriber) => {
                try {
                    // Remove close listeners first to prevent recursive calls
                    cleanupSubscriberListeners(subscriber, RED);
                    
                    subscriber.socket._res.write(`event: close\n`);
                    subscriber.socket._res.write(`data: Node closed\n`);
                    subscriber.socket._res.write(`id: 0\n\n`);
                    if (subscriber.socket._res.flush)
                        subscriber.socket._res.flush();
                    subscriber.socket._res.end();
                } catch (e) {
                    RED.log.warn(
                        `Error closing subscriber response: ${e.message}`,
                    );
                }
            });
            this.subscribers = [];
            // Remove runtime-event listener to prevent memory leaks
            if (this._runtimeHandler) {
                RED.events.removeListener('runtime-event', this._runtimeHandler);
                this._runtimeHandler = null;
            }
            if (done) done();
        });

		// When a runtime event, such as redeploy, is registered, close all connections
		this._runtimeHandler = () => {
			updateNodeStatus(this, 'success');
			this.subscribers.forEach((subscriber) => {
				try {
					// Remove close listeners first to prevent recursive calls
					cleanupSubscriberListeners(subscriber, RED);
					
					subscriber.socket._res.write(`event: close\n`);
					subscriber.socket._res.write(`data: Collection closed\n`);
					subscriber.socket._res.write(`id: 0\n\n`);
					if (subscriber.socket._res.flush) subscriber.socket._res.flush();
					subscriber.socket._res.end();
				} catch (e) {
					RED.log.warn(
                        `Error closing subscriber response: ${e.message}`,
                    );
				}
			});
			// Clean the subscriber list to avoid memory leaks
			this.subscribers = [];
		};
		RED.events.on('runtime-event', this._runtimeHandler);
	}
	RED.nodes.registerType('sse-server', CreateSseServerNode);
};
