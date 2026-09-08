/** @fileoverview BitTorrent peer identification: bitfield parsing and client detection. */
import { UNKNOWN_PEERID, UNKNOWN_PEERID_NAME } from '@shared/constants'
import { logger } from '@shared/logger'

const PEER_CLIENT_MAP: Record<string, string> = {
  AG: 'Ares',
  'A~': 'Ares',
  AR: 'Arctic',
  AV: 'Avicora',
  AX: 'BitPump',
  AZ: 'Azureus',
  BB: 'BitBuddy',
  BC: 'BitComet',
  BF: 'Bitflu',
  BG: 'BTG',
  BR: 'BitRocket',
  BS: 'BTSlave',
  BX: 'Bittorrent X',
  CD: 'Enhanced CTorrent',
  CT: 'CTorrent',
  DE: 'DelugeTorrent',
  DP: 'Propagate',
  EB: 'EBit',
  ES: 'electric sheep',
  FT: 'FoxTorrent',
  FW: 'FrostWire',
  GS: 'GSTorrent',
  HL: 'Halite',
  HN: 'Hydranode',
  KG: 'KGet',
  KT: 'KTorrent',
  LH: 'LH-ABC',
  LP: 'Lphant',
  LT: 'libtorrent',
  lt: 'libTorrent',
  LW: 'LimeWire',
  MO: 'MonoTorrent',
  MP: 'MooPolice',
  MR: 'Miro',
  MT: 'MoonlightTorrent',
  NX: 'Net Transport',
  PD: 'Pando',
  qB: 'qBittorrent',
  QD: 'QQDownload',
  QT: 'Qt 4 Torrent',
  RT: 'Retriever',
  'S~': 'Shareaza alpha/beta',
  SB: 'Swiftbit',
  SS: 'SwarmScope',
  ST: 'SymTorrent',
  st: 'sharktorrent',
  SZ: 'Shareaza',
  TN: 'TorrentDotNET',
  TR: 'Transmission',
  TS: 'Torrentstorm',
  TT: 'TuoTu',
  UL: 'uLeecher!',
  UM: 'µTorrent Mac',
  UT: 'µTorrent',
  VG: 'Vagaa',
  WD: 'WebTorrent Desktop',
  WT: 'BitLet',
  WW: 'WebTorrent',
  WY: 'FireTorrent',
  XL: 'Xunlei',
  XT: 'XanTorrent',
  XX: 'Xtorrent',
  ZT: 'ZipTorrent',
}

/** Converts an aria2 hex bitfield string to a download completion percentage. */
export const bitfieldToPercent = (text: string): string => {
  const len = text.length
  if (len === 0) return '0'
  let p: number
  let one = 0
  for (let i = 0; i < len; i++) {
    p = parseInt(text[i], 16)
    for (let j = 0; j < 4; j++) {
      one += p & 1
      p >>= 1
    }
  }
  return Math.floor((one / (4 * len)) * 100).toString()
}

export const peerIdParser = (str: string): string => {
  if (!str || str === UNKNOWN_PEERID) {
    return UNKNOWN_PEERID_NAME
  }
  let decoded = str
  try {
    decoded = decodeURIComponent(str)
  } catch (e) {
    logger.debug('parsePeerId.decode', e)
  }
  if (decoded.startsWith('-') && decoded.length >= 8) {
    const clientId = decoded.substring(1, 3)
    const versionRaw = decoded.substring(3, 7)
    const clientName = PEER_CLIENT_MAP[clientId]
    if (clientName) {
      const version = versionRaw.replace(/-+$/, '').split('').join('.')
      return `${clientName} ${version}`
    }
  }
  return UNKNOWN_PEERID_NAME
}
