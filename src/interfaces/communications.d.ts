// Types for communications between socks-to-rtc and rtc-to-net.

declare module Channel {

  export enum COMMANDS {
    NET_CONNECT_REQUEST = 1,
    NET_CONNECT_RESPONSE = 2,
    NET_DISCONNECTED = 3,
    SOCKS_DISCONNECTED = 4,
    PING = 6,
    PONG = 7
  }

  // Base class for commands (sent via text messages).
  export interface Command {
    // Type of message, e.g. NetConnectRequest.
    type:COMMANDS;
  }

  // Requests a connection be established with a remote server.
  export interface NetConnectRequest extends Command {
    // 'tcp' or 'udp'.
    protocol:string;
    // Destination address and port.
    address:string;
    port:number;
  }

  export interface NetConnectResponse extends Command {
    // Address and port on which we have made the connection to the
    // remote server, or both undefined if the connection could not be
    // made.
    address?:string;
    port?:number;
  }

  // Used for communication between the TCP-facing SOCKS server and the
  // WebRTC-facing SocksToRTC module. At some point these might diverge
  // but right now they both need to send data to the other side and
  // be notified of terminations from the other side so this common
  // interface works for us.
  export interface EndpointInfo {
    // 'tcp' or 'udp'.
    protocol:string;
    // Address on which we connected to the remote server.
    address:string;
    // Port on which we connected to the remote server.
    port:number;
    // Function which sends data to the other side.
    send:(bytes:ArrayBuffer) => any;
    // Function which tells the other side to terminate.
    terminate:() => any;
  }

  // Used to batch messages sent over the signalling channel.
  // TODO: rename to MessageBatch
  export interface BatchedMessages {
    version :number;
    messages :string[];
  }

}  // module Channel


// Target peer's information, to be sent over a signalling channel.
interface PeerInfo {
  host:string;
  port:number;
  peerId:string;
}

interface PeerSignal {
  peerId:string;
  data:string;  // Expected in JSON-format.
}
