// TODO: Make these actually typed, and probably shove into freedom.
interface PeerConnection {
  on:(event:string,f:any)=>void;
  setup:any;
  close:any;
  send:any;
  closeDataChannel:any
}