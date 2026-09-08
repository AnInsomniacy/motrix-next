export const BT_PEER_ID_PREFIX_MAX_BYTES = 20

export function isValidBtUserAgent(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\r') && !value.includes('\n')
}

export function isValidBtPeerIdPrefix(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    new TextEncoder().encode(value).length <= BT_PEER_ID_PREFIX_MAX_BYTES
  )
}
