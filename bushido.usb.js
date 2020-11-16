const ANT_SYNC_BYTE = 0xa4;

class Message {

    constructor(type, content) {
        this._type = type;
        this._content = content;
    }

    header() {
        return [
            ANT_SYNC_BYTE,
            this._content.length,
            this._type,
        ];
    }

    checksum() {
        return this.header()
            .concat(this._content)
            .reduce((prev, cur) => prev ^ cur, 0);
    }

    encode() {
        const bytes = this.header()
            .concat(this._content)
            .concat(this.checksum());
        return new Uint8Array(bytes);
    }

    getContent() {
        return this._content;
    }

    getType() {
        return this._type;
    }
}


class MessageChecksumError extends Error {
    constructor() {
        super("Message checksum is wrong!");
    }
}


class ResetMessage extends Message {

    constructor() {
        super(0xA4, [0x00]);
    }
}


class SetNetworkKeyMessage extends Message {

    constructor(key) {
        super(0x46, [0x00, ...key]);
    }
}


class AssignChannelMessage extends Message {

    constructor(type) {
        super(0x42, [0x00, type, 0x00]);
    }
}


class SetChannelIdMessage extends Message {

    constructor(deviceType) {
        super(0x51, [0x00, 0x00, 0x00, deviceType, 0x00]);
    }
}


class SetChannelPeriodMessage extends Message {

    constructor(period) {
        const buffer = new ArrayBuffer(2);
        const view = new DataView(buffer);
        view.setUint16(0, period, true);
        super(0x43, [0x00, view.getUint8(0), view.getUint8(1)]);
    }
}


class SetChannelRfFrequencyMessage extends Message {

    constructor(frequency) {
        super(0x45, [0x00, frequency - 2400]);
    }
}


class OpenChannelMessage extends Message {

    constructor() {
        super(0x4b, [0x00]);
    }
}


class BroadcastMessage extends Message {

    constructor(data) {
        super(0x4e, [0x00, ...data]);
    }
}


class BushidoResetHeadUnitMessage extends BroadcastMessage {
    
    constructor() {
        super([0xac, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
    }
}


class BushidoContinueMessage extends BroadcastMessage {

    constructor() {
        super([0xac, 0x03, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]);
    }
}


class BushidoStartCyclingMessage extends BroadcastMessage {
    
    constructor() {
        super([0xac, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]);
    }
}


class BushidoInitPCConnectionMessage extends BroadcastMessage {

    constructor() {
        super([0xac, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
    }
}


class BushidoStartTimeSlopeMessage extends BroadcastMessage {

    constructor() {
        super([0xdc, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    }
}


class BushidoData01Message extends BroadcastMessage {

    constructor(slope, weight) {
        const corrected_slope = Math.max(-50, Math.min(200, Math.round(slope * 10.0)));
        if (corrected_slope < 0) {
            super([0xdc, 0x01, 0x00, 0xff, 256 + corrected_slope, weight, 0x00, 0x00]);
        } else {
            super([0xdc, 0x01, 0x00, 0x00, corrected_slope, weight, 0x00, 0x00]);
        }
    }
}

class BushidoData02Message extends BroadcastMessage {

    constructor() {
        super([0xdc, 0x02, 0x00, 0x99, 0x00, 0x00, 0x00, 0x00]);
    }
}


class BushidoData {

    constructor() {
        this.speed = 0;
        this.cadence = 0;
        this.power = 0;
        this.distance = 0;
        this.break_temp = 0;
        this.heart_rate = 0;
        this.slope = 0;
        this.weight = 70;
    }
}


class BushidoUSB {

    constructor(log = null, {
        onPaused,
        onResumed,
        onDataUpdated,
        onDistanceUpdated,
    } = {}) {
        this._device = null;
        this._data = new BushidoData();
        this._running = false;
        this._is_paused = false;
        this._out_queue = [];
        this._in_buffer = [];
        this._log = log;
        this._connected = false;

        this.onPaused = onPaused;
        this.onResumed = onResumed;
        this.onDataUpdated = onDataUpdated;
        this.onDistanceUpdated = onDistanceUpdated;
    }

    getData() {
        return this._data;
    }

    setSlope(slope) {
        this._data.slope = slope;
    }

    isPaused() {
        return this._is_paused;
    }

    isConnected() {
        return this._connected;
    }

    async init() {
        this._device = await navigator.usb.requestDevice({
            filters: [{
                vendorId: 0x0FCF,
                productId: 0x1008,
            }]
        });

        await this._device.open();
        this._log_info("device", this._device, "opened");

        await this._device.selectConfiguration(1);
        this._log_info("config selected");
        
        await this._device.claimInterface(0);
        this._log_info("interface claimed");
    }

    async run() {
        this._initializeANTConnection();
        this._initializeBushidoConnection();

        this._connected = true;

        // send & receive loop
        this._running = true;
        while (this._running) {
            await this._sendMessage();
            const in_message = await this._receiveMessage();
            this._processMessage(in_message);
        }
    }

    _initializeANTConnection() {
        this._queueMessage(new ResetMessage());
        this._queueMessage(new AssignChannelMessage([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        this._queueMessage(new SetChannelIdMessage(0x52));
        this._queueMessage(new SetChannelPeriodMessage(4096));
        this._queueMessage(new SetChannelRfFrequencyMessage(2460));
        this._queueMessage(new OpenChannelMessage());
    }

    _initializeBushidoConnection() {
        this._queueMessage(new BushidoInitPCConnectionMessage());
        this._queueMessage(new BushidoResetHeadUnitMessage());
        this._queueMessage(new BushidoStartCyclingMessage());
    }

    _sendData() {
        this._queueMessage(new BushidoData01Message(this._data.slope, this._data.weight));
        this._queueMessage(new BushidoData02Message());
    }

    _continue() {
        this._queueMessage(new BushidoContinueMessage());
    }

    async _sendMessage() {
        let out_message = null;
        do {
            out_message = this._out_queue.shift();
            if (out_message === undefined) break;
            const message_bytes = out_message.encode();
            await this._device.transferOut(1, message_bytes);

            // retry send every second
            const interval_handle = setInterval(async () => {
                await this._device.transferOut(1, message_bytes);
            }, 1000);

            // wait for ACK
            while (true) {
                const in_msg = await this._receiveMessage();
                if (in_msg.getType() === 0x40) {
                    if ((in_msg.getContent()[1] === out_message.getType())) {
                        clearInterval(interval_handle);
                        break;
                    } else if (in_msg.getContent()[1] === 0x01 && in_msg.getContent()[2] === 0x03) {
                        clearInterval(interval_handle);
                        break;
                    }
                }
            }

        } while (!(out_message instanceof BroadcastMessage));
    }
    
    async _receiveMessage() {
        let in_message = null;
        do {
            const message_trans_type = new DataView((await this._device.transferIn(1, 1)).data.buffer).getUint8();
            if (message_trans_type === ANT_SYNC_BYTE) {
                const message_size = new DataView((await this._device.transferIn(1, 1)).data.buffer).getUint8();
                const message_body = new Uint8Array((await this._device.transferIn(1, message_size + 2)).data.buffer);
                const message_type = message_body[0];
                const message_content = [...message_body.slice(1, message_size + 1)];
                const message_checksum = message_body[message_size + 1];
                in_message = new Message(message_type, message_content);
                if (in_message.checksum() !== message_checksum) {
                    throw new MessageChecksumError();
                }
            }
        } while (in_message === null);
        return in_message;
    }

    _processMessage(message) {
        const data = message.getContent();
        data.shift();
        if (data[0] === 0xdd) {
            if (data[1] === 0x01) {
                this._data.speed = ((data[2] << 8) + data[3]) / 10.0;
                this._data.power = (data[4] << 8) + data[5];
                this._data.cadence = data[6];
                if (this.onDataUpdated) this.onDataUpdated(this._data);
            } else if (data[1] === 0x02) {
                const old_distance = this._data.distance;
                this._data.distance = (((data[2] << 24) + data[3] << 16) + data[4] << 8) + data[5];
                this._data.heart_rate = data[6];
                if (this.onDataUpdated) this.onDataUpdated(this._data);
                if (old_distance !== this._data.distance && this.onDistanceUpdated) this.onDistanceUpdated(this._data.distance);
            } else if (data[1] === 0x03) {
                this._data.break_temp = data[4];
                if (this.onDataUpdated) this.onDataUpdated(this._data);
            }
        } else if (data[0] === 0xad) {
            if (data[1] === 0x01 && data[2] === 0x02) {
                this._is_paused = false;
                if (this.onResumed) this.onResumed();
                this._log_info("sending slope of:", this._data.slope);
                this._sendData();
            } else if (data[1] === 0x01 && data[2] === 0x03) {
                this._is_paused = true;
                this._log_info("sending continue message ...");
                if (this.onPaused) this.onPaused();
                this._continue();
            }
        }
    }

    _queueMessage(message) {
        this._out_queue.push(message);
    }

    _log_info(...msg) {
        if (this._log) {
            this._log.info(...msg);
        }
    }

    _log_warn(...msg) {
        if (this._log) {
            this._log.warn(...msg);
        }
    }

    _log_error(...msg) {
        if (this._log) {
            this._log.error(...msg);
        }
    }
}