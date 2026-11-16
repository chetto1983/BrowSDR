export interface RtlTcpHeader {
	tunerType: number;
	tuner: string;
	gainCount: number;
}

export type RtlTcpSocketFactory = (url: string) => WebSocket;

/** Where this connection stands on the Pi relay: tuning, listening, gone, or not knowable. */
export type RelayRole = 'controller' | 'listener' | 'absent';

/** The part of the relay's GET /status that identifies clients. */
export interface RelayClients {
	clients: Array<{ controller: boolean; client?: string }>;
}
