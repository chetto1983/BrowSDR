export interface RtlTcpHeader {
	tunerType: number;
	tuner: string;
	gainCount: number;
}

export type RtlTcpSocketFactory = (url: string) => WebSocket;
