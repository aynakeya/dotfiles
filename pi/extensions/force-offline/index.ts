export default function forceOffline(): void {
	process.env.PI_OFFLINE = "1";
}
