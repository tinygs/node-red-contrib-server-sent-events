/**
 *
 * @param {string | Object} data
 * @returns
 */
function _serializeData(data) {
	return typeof data === 'string' ? data : JSON.stringify(data);
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
    RED.log.debug('Client connected');
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
    const clientIP = msg.res._res.req.socket.remoteAddress;

    // Close a SSE connection when client disconnects
    const closeHandler = () => {
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
            
            // Emit disconnect message
            node.send({
                _msgid: subscriberId,
                payload: {
                    event: 'disconnect',
                    subscribers: node.subscribers.length,
                    ip: clientIP,
                }
            });
        }
        updateNodeStatus(node, 'success');
        // Remove the listener to avoid memory leaks
        responseSocket._res.req.removeListener('close', closeHandler);
    };
    
    responseSocket._res.req.on('close', closeHandler);

    // Prevent adding the same subscriber twice
    if (!node.subscribers.some((sub) => sub.id === subscriberId)) {
        node.subscribers.push({
            id: subscriberId,
            socket: responseSocket,
            closeHandler: closeHandler, // Store reference for manual cleanup
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
function unregisterSubscriber(node, msg) {
    const subscriberId = msg._msgid;
    const subscriberIndex = node.subscribers.findIndex(sub => sub.id === subscriberId);
    
    if (subscriberIndex === -1) {
        RED.log.warn(`Subscriber ${subscriberId} not found for unregistration`);
        return;
    }
    
    const subscriber = node.subscribers[subscriberIndex];
    
    // Write out closing message to client
    try {
        msg.res._res.write('event: close\n');
        msg.res._res.write(`data: The connection was closed by the server.\n`);
        msg.res._res.write(`id: ${subscriberId}\n\n`);
        if (msg.res._res.flush) msg.res._res.flush();
    } catch (e) {
        RED.log.warn(`Error writing close event: ${e.message}`);
    }

    // Clean up event listener to prevent memory leak
    if (subscriber.closeHandler) {
        try {
            subscriber.socket._res.req.removeListener('close', subscriber.closeHandler);
        } catch (e) {
            RED.log.warn(`Error removing close listener: ${e.message}`);
        }
    }

    // Remove the subscriber from the list
    node.subscribers.splice(subscriberIndex, 1);
    
    try {
        msg.res._res.end();
    } catch (e) {
        RED.log.warn(`Error closing response: ${e.message}`);
    }
    
    // Emit output message on client disconnect
    msg.payload = {
        event: 'disconnect',
        subscribers: node.subscribers.length,
        ip: msg.res._res.req.socket.remoteAddress,
    };
    node.send(msg);
}

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
	
	RED.log.debug(`Sent event: ${event}`);
	RED.log.debug(`Data: ${data}`);
	node.subscribers = node.subscribers.filter((subscriber) => {
		try {
			subscriber.socket._res.write(`event: ${event}\n`);
			subscriber.socket._res.write(`data: ${data}\n`);
			subscriber.socket._res.write(`id: ${messageId}\n\n`);
			if (subscriber.socket._res.flush) subscriber.socket._res.flush();
			return true;
		} catch (e) {
			RED.log.warn(
                `Error sending event to subscriber ${subscriber.id}: ${e.message}`,
            );
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
                    // Remove close listener first to prevent recursive calls
                    if (subscriber.closeHandler) {
                        subscriber.socket._res.req.removeListener('close', subscriber.closeHandler);
                    }
                    
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
					// Remove close listener first to prevent recursive calls
					if (subscriber.closeHandler) {
						subscriber.socket._res.req.removeListener('close', subscriber.closeHandler);
					}
					
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
