// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/names.rs (hardware models of mesh.proto HardwareModel,
// port numbers of portnums.proto, device roles of config.proto Config.DeviceConfig.Role and routing errors of mesh.proto
// Routing.Error, generated there from meshtastic/protobufs of 2026-10) and rust/onair_mesh/src/tables.rs (channel hash,
// key expansion), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts: Meshtastic (Meshtastic
// contributors, GPL-3.0). Changes: the hardware models 0..150 as one word list (plus 255).

const words = (s: string): string[] => s.trim().split(/\s+/);

/** Hardware models 0..150 by value (255 PRIVATE_HW). */
const HW_MODELS = words(`
UNSET TLORA_V2 TLORA_V1 TLORA_V2_1_1P6 TBEAM HELTEC_V2_0 TBEAM_V0P7 T_ECHO TLORA_V1_1P3 RAK4631 HELTEC_V2_1
HELTEC_V1 LILYGO_TBEAM_S3_CORE RAK11200 NANO_G1 TLORA_V2_1_1P8 TLORA_T3_S3 NANO_G1_EXPLORER NANO_G2_ULTRA
LORA_TYPE WIPHONE WIO_WM1110 RAK2560 HELTEC_HRU_3601 HELTEC_WIRELESS_BRIDGE STATION_G1 RAK11310
MAKERFABS_TRACKER MAKERFABS_RESERVED CANARYONE RP2040_LORA STATION_G2 LORA_RELAY_V1 T_ECHO_PLUS PPR
GENIEBLOCKS NRF52_UNKNOWN PORTDUINO ANDROID_SIM DIY_V1 NRF52840_PCA10059 DR_DEV M5STACK HELTEC_V3
HELTEC_WSL_V3 BETAFPV_2400_TX BETAFPV_900_NANO_TX RPI_PICO HELTEC_WIRELESS_TRACKER HELTEC_WIRELESS_PAPER
T_DECK T_WATCH_S3 PICOMPUTER_S3 HELTEC_HT62 EBYTE_ESP32_S3 ESP32_S3_PICO CHATTER_2 HELTEC_WIRELESS_PAPER_V1_0
HELTEC_WIRELESS_TRACKER_V1_0 UNPHONE TD_LORAC CDEBYTE_EORA_S3 TWC_MESH_V4 NRF52_PROMICRO_DIY
RADIOMASTER_900_BANDIT_NANO HELTEC_CAPSULE_SENSOR_V3 HELTEC_VISION_MASTER_T190 HELTEC_VISION_MASTER_E213
HELTEC_VISION_MASTER_E290 HELTEC_MESH_NODE_T114 SENSECAP_INDICATOR TRACKER_T1000_E RAK3172 WIO_E5
RADIOMASTER_900_BANDIT ME25LS01_4Y10TD RP2040_FEATHER_RFM95 M5STACK_COREBASIC M5STACK_CORE2 RPI_PICO2
M5STACK_CORES3 SEEED_XIAO_S3 MS24SF1 TLORA_C6 WISMESH_TAP ROUTASTIC MESH_TAB MESHLINK XIAO_NRF52_KIT
THINKNODE_M1 THINKNODE_M2 T_ETH_ELITE HELTEC_SENSOR_HUB MUZI_BASE HELTEC_MESH_POCKET SEEED_SOLAR_NODE
NOMADSTAR_METEOR_PRO CROWPANEL LINK_32 SEEED_WIO_TRACKER_L1 SEEED_WIO_TRACKER_L1_EINK MUZI_R1_NEO T_DECK_PRO
T_LORA_PAGER M5STACK_RESERVED WISMESH_TAG RAK3312 THINKNODE_M5 HELTEC_MESH_SOLAR T_ECHO_LITE HELTEC_V4
M5STACK_C6L M5STACK_CARDPUTER_ADV HELTEC_WIRELESS_TRACKER_V2 T_WATCH_ULTRA THINKNODE_M3 WISMESH_TAP_V2 RAK3401
RAK6421 THINKNODE_M4 THINKNODE_M6 MESHSTICK_1262 TBEAM_1_WATT T5_S3_EPAPER_PRO TBEAM_BPF MINI_EPAPER_S3
TDISPLAY_S3_PRO HELTEC_MESH_NODE_T096 MESH_TRACKER_X1 THINKNODE_M7 THINKNODE_M8 THINKNODE_M9 HELTEC_V4_R8
HELTEC_MESH_NODE_T1 STATION_G3 T_IMPULSE_PLUS T_ECHO_CARD SEEED_WIO_TRACKER_L2 CROWPANEL_P4
HELTEC_MESH_TOWER_V2 MESHNOLOGY_W10 HELTEC_RC32 HELTEC_RC52 HELTEC_RCC6 SEEED_WIO_TRACKER_L1_PRO_1W
MESHNOLOGY_W12 MESHPAGER_X2 T_CONNECT_PRO AXIOMETA_GENESIS_MINI MAKERFABS_NOMAD_TERMINAL THINKNODE_MX`);

/** Port numbers (portnums.proto PortNum). */
const PORT_NUMS = new Map<number, string>([
	[0, 'UNKNOWN_APP'],
	[1, 'TEXT_MESSAGE_APP'],
	[2, 'REMOTE_HARDWARE_APP'],
	[3, 'POSITION_APP'],
	[4, 'NODEINFO_APP'],
	[5, 'ROUTING_APP'],
	[6, 'ADMIN_APP'],
	[7, 'TEXT_MESSAGE_COMPRESSED_APP'],
	[8, 'WAYPOINT_APP'],
	[9, 'AUDIO_APP'],
	[10, 'DETECTION_SENSOR_APP'],
	[11, 'ALERT_APP'],
	[12, 'KEY_VERIFICATION_APP'],
	[13, 'REMOTE_SHELL_APP'],
	[32, 'REPLY_APP'],
	[33, 'IP_TUNNEL_APP'],
	[34, 'PAXCOUNTER_APP'],
	[35, 'STORE_FORWARD_PLUSPLUS_APP'],
	[36, 'NODE_STATUS_APP'],
	[37, 'MESH_BEACON_APP'],
	[38, 'PAGING_APP'],
	[64, 'SERIAL_APP'],
	[65, 'STORE_FORWARD_APP'],
	[66, 'RANGE_TEST_APP'],
	[67, 'TELEMETRY_APP'],
	[68, 'ZPS_APP'],
	[69, 'SIMULATOR_APP'],
	[70, 'TRACEROUTE_APP'],
	[71, 'NEIGHBORINFO_APP'],
	[72, 'ATAK_PLUGIN'],
	[73, 'MAP_REPORT_APP'],
	[74, 'POWERSTRESS_APP'],
	[75, 'LORAWAN_BRIDGE'],
	[76, 'RETICULUM_TUNNEL_APP'],
	[77, 'CAYENNE_APP'],
	[78, 'ATAK_PLUGIN_V2'],
	[79, 'LORA_OTA_APP'],
	[112, 'GROUPALARM_APP'],
	[256, 'PRIVATE_APP'],
	[257, 'ATAK_FORWARDER'],
	[511, 'MAX'],
]);

/** Device roles 0..12 (config.proto Config.DeviceConfig.Role). */
const ROLES = words(
	'CLIENT CLIENT_MUTE ROUTER ROUTER_CLIENT REPEATER TRACKER SENSOR TAK CLIENT_HIDDEN LOST_AND_FOUND TAK_TRACKER ROUTER_LATE CLIENT_BASE',
);

/** Routing errors (mesh.proto Routing.Error). */
export const ROUTING_ERRORS = new Map<number, string>([
	...words('NONE NO_ROUTE GOT_NAK TIMEOUT NO_INTERFACE MAX_RETRANSMIT NO_CHANNEL TOO_LARGE NO_RESPONSE DUTY_CYCLE_LIMIT').map(
		(n, i): [number, string] => [i, n],
	),
	...words(
		'BAD_REQUEST NOT_AUTHORIZED PKI_FAILED PKI_UNKNOWN_PUBKEY ADMIN_BAD_SESSION_KEY ADMIN_PUBLIC_KEY_UNAUTHORIZED RATE_LIMIT_EXCEEDED PKI_SEND_FAIL_PUBLIC_KEY',
	).map((n, i): [number, string] => [32 + i, n]),
]);

/** Hardware model name, or HW_<n>. */
export const hwModelName = (hw: number): string => (hw === 255 ? 'PRIVATE_HW' : (HW_MODELS[hw] ?? `HW_${hw}`));
/** The value of a hardware model name, -1 when unknown. */
export const hwModelValue = (name: string): number => (name === 'PRIVATE_HW' ? 255 : HW_MODELS.indexOf(name));
/** Port name, or PORT_<n>. */
export const portName = (port: number): string => PORT_NUMS.get(port) ?? `PORT_${port}`;
/** Role name, or ROLE_<n>. */
export const roleName = (role: number): string => ROLES[role] ?? `ROLE_${role}`;

/** `!%08x` of a node number. */
export const nodeId = (n: number): string => `!${(n >>> 0).toString(16).padStart(8, '0')}`;
/** `^all` for the broadcast address, else the node id. */
export const nodeStr = (n: number): string => (n >>> 0 === 0xffffffff ? '^all' : nodeId(n));

/** Channel hash byte: xor of the name bytes and of the key bytes (Channels.cpp generateHash). */
export function channelHash(name: string, key: Uint8Array): number {
	let h = 0;
	for (const b of new TextEncoder().encode(name)) h ^= b;
	for (const b of key) h ^= b;
	return h;
}
