const EventSource = require("eventsource");

/**
 * Handles an event by logging it and sending a message to the node with a generated ID, topic, and payload.
 *
 * @param {Object} RED - the global RED object
 * @param {Object} node - the node object that received the event
 * @param {Object} event - the event object received
 * @return {void}
 */
function handleEvent(RED, node, event) {
  RED.log.debug(`Received event: from ${this.url} - ${event.type}`);
  node.send({
    _msid: RED.util.generateId(),
    topic: event.type,
    payload: event.data,
  });
}

/**
 * Handles errors from an event source.
 *
 * @param {Object} RED - the Node-RED runtime object
 * @param {Object} node - the node that received the error
 * @param {Error} err - the error that occurred
 * @return {void}
 */
function handleEventSourceError(RED, node, config, err) {
  // Count the amount of times an error occured
  //node._counter = (node._counter || 0) + 1;
  const falseError = err.message === undefined || err.message === null;
    const errorMessage = err.message ? err.message : "Connection error";
    if (!falseError) {
        RED.log.error(errorMessage);
        node.send({
            _msid: RED.util.generateId(),
            error: errorMessage,
        });
        node.status({
            fill: "yellow",
            shape: "dot",
            text: `${errorMessage} | Trying again in ${node.connectionAttemptInterval / 1000
                } seconds`,
        });
        node.error(errorMessage);
    }
//   if (node._counter < node.maxConnectionAttempts) {
    cleanupEventSource(node.eventSource, RED);
    node.eventSource = null;
    setTimeout(
      () => connect(RED, node, config, false),
      falseError ? 50 : node.connectionAttemptInterval
    );
//   } else {
    // cleanupEventSource(node.eventSource);
    // node.eventSource = null;
    // node.status({
    //   fill: "red",
    //   shape: "dot",
    //   text: `Failed to connect to ${node.url} after ${node._counter} attempts`,
    // });
 // }
}

/**
 * Removes all listeners from the EventSource instance and closes it.
 * Ensures the underlying socket is properly destroyed to notify the server.
 * @param {EventSource} eventSource
 * @param {Object} RED - the Node-RED runtime object for logging
 */
function cleanupEventSource(eventSource, RED) {
  if (!eventSource) return;
  
  try {
    // Remove all known listeners first
    if (eventSource.removeAllListeners) {
      eventSource.removeAllListeners();
    }
    
    // Try to abort the underlying request to force TCP close
    // The eventsource library stores the request in _req
    if (eventSource._req) {
      if (eventSource._req.destroy) {
        eventSource._req.destroy();
      } else if (eventSource._req.abort) {
        eventSource._req.abort();
      }
    }
    
    // Close the EventSource
    if (eventSource.close) {
      eventSource.close();
    }
    
    if (RED) {
      RED.log.debug('EventSource cleaned up and socket destroyed');
    }
  } catch (e) {
    if (RED) {
      RED.log.warn(`Error during EventSource cleanup: ${e.message}`);
    }
  }
}

function connect(RED, node, config, isInitialConnect = false) {
  // Only call createNode on initial connect, not on reconnections
  if (isInitialConnect) {
    RED.nodes.createNode(node, config);
    // Register close event of the node runtime only once
    node.on("close", () => handleEventSourceClose(RED, node, config));
  }

  // Clean up previous instance if it exists
  if (node.eventSource) {
    cleanupEventSource(node.eventSource, RED);
    node.eventSource = null;
  }

  // General event source variables
  node.eventSource = new EventSource(node.url, {
    withCredentials: true,
    headers: node.headers,
  });

  node.status({
    fill: "green",
    shape: "dot",
    text: `Connected to ${node.url}`,
  });

  // Register default message event
  node.eventSource.on(node.event, (event) => handleEvent(RED, node, event));

  // Register error event
  node.eventSource.on("error", (err) =>
    handleEventSourceError(RED, node, config, err)
  );

  RED.log.info(`Successfully connected to ${node.url}`);
}

/**
 * Closes the eventSource and logs a debug message.
 *
 * @param {Object} RED - The Node-RED runtime object.
 * @param {Object} node - The node instance that the function is called on.
 * @return {void}
 */
function handleEventSourceClose(RED, node, _config) {
  RED.log.debug(`Closing event source: ${node.url}`);
  cleanupEventSource(node.eventSource, RED);
    node.eventSource = null;
    node.status({});
}

module.exports = function (RED) {
  /**
   * Creates a new SSE (Server-Sent Events) client node.
   *
   * @param {Object} config - Node-RED node configuration object.
   */
  function CreateSseClientNode(config) {
    try {
      this.url = config.url;
      this.event = config.event;
      this.headers = config.headers ? JSON.parse(config.headers) : {};
      //this._counter = 0;
      this.maxConnectionAttempts = config.maxConnectionAttempts || 5;
      this.connectionAttemptInterval = config.connectionAttemptInterval || 5000;
      //this.reconnectOnClose = config.reconnectOnClose === "true";

      connect(RED, this, config, true);

    //   const resetTimeout = this.connectionAttemptInterval;
        //this.maxConnectionAttempts * this.connectionAttemptInterval;
    //   RED.log.debug(`Reset counter for ${this.url} in ${resetTimeout / 1000} seconds`);
    //   setTimeout(() => {
    //     this._counter = 0;
    //     RED.log.debug(`Reset counter for ${this.url}`);
    //   }, resetTimeout);
    } catch (error) {
      this.status({
        fill: "red",
        shape: "dot",
        text: `${error.message}`,
      });
      RED.log.error(error);
    }
  }
  RED.nodes.registerType("sse-client", CreateSseClientNode);
};
