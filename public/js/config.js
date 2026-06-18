export const Config = {
    IPs: {
        DEV: "192.168.1.18",
        PROD: "192.168.1.11",
        DEV2: "192.168.1.26",
   },
    getSocketUrl(ip, port) {
        return `ws://${ip}:${port}`;
    }
};

