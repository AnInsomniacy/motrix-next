declare module 'bencode' {
    function decode(data: Uint8Array | ArrayBuffer | Buffer | string): any
    function encode(data: any): Uint8Array
    export default { decode, encode }
}
