/**
 * 抖音 IM Protobuf 编解码（最小化实现）
 *
 * 抖音 IM API 使用 application/x-protobuf 格式。
 * 本模块仅实现我们需要的字段类型：
 *   - varint (wire 0): cmd / sequence_id / inbox_type / refer / auth_type 等
 *   - string/bytes (wire 2): sdk_version / build_number / body / headers map 等
 *   - map<string,string>: field 15 headers map (每个 entry 是一个 LengthDelimited field)
 *
 * 不依赖第三方库，纯 Buffer 操作。
 */
export var WireType;
(function (WireType) {
    WireType[WireType["Varint"] = 0] = "Varint";
    WireType[WireType["Fixed64"] = 1] = "Fixed64";
    WireType[WireType["LengthDelimited"] = 2] = "LengthDelimited";
    WireType[WireType["StartGroup"] = 3] = "StartGroup";
    WireType[WireType["EndGroup"] = 4] = "EndGroup";
    WireType[WireType["Fixed32"] = 5] = "Fixed32";
})(WireType || (WireType = {}));
/** 编码 varint（无符号，LSB first，每字节 7 bits，MSB 为 continuation bit）
 *
 * 支持 number 或 bigint。对于 int64 大数字（如 conversation_short_id）应使用 bigint 或 string。
 */
export function encodeVarint(n) {
    let big;
    if (typeof n === 'bigint') {
        big = n;
    }
    else {
        if (n < 0) {
            // 用 32-bit 补码循环（避免负数报错，抖音部分字段可能传负数）
            big = BigInt(n >>> 0);
        }
        else {
            big = BigInt(n);
        }
    }
    const bytes = [];
    while (big > 0x7fn) {
        bytes.push(Number(big & 0x7fn) | 0x80);
        big >>= 7n;
    }
    bytes.push(Number(big & 0x7fn));
    return Buffer.from(bytes);
}
/** 编码 tag (field_number << 3 | wire_type) */
export function encodeTag(field, wire) {
    return encodeVarint((field << 3) | wire);
}
/** 编码 varint 字段（值可以是 number 或 bigint，用于支持 int64） */
export function encodeVarintField(field, value) {
    return Buffer.concat([encodeTag(field, WireType.Varint), encodeVarint(value)]);
}
/** 编码 string 字段 */
export function encodeStringField(field, value) {
    const body = Buffer.from(value, 'utf-8');
    return Buffer.concat([
        encodeTag(field, WireType.LengthDelimited),
        encodeVarint(body.length),
        body,
    ]);
}
/** 编码 bytes 字段（field 8 body 嵌套 message 也用这个） */
export function encodeBytesField(field, value) {
    return Buffer.concat([
        encodeTag(field, WireType.LengthDelimited),
        encodeVarint(value.length),
        value,
    ]);
}
/** 编码 map<string,string> 的一个 entry（每个 entry 是一个 LengthDelimited field） */
export function encodeMapEntry(field, key, value) {
    // entry 是嵌套 message：field 1 = key, field 2 = value
    const entryBody = Buffer.concat([
        encodeStringField(1, key),
        encodeStringField(2, value),
    ]);
    return encodeBytesField(field, entryBody);
}
/** 解码 varint（从 buffer 指定位置开始）
 *
 * 注意：JavaScript 位运算 << 会截断到 32 位，无法正确处理超过 4 字节的 varint
 * （如 conversation_short_id 是 9 字节 int64）。因此内部使用 BigInt 计算保证精度。
 *
 * 返回：
 *   - value: number（低 53 位，向后兼容；超过 2^53 会丢失精度）
 *   - bigValue: bigint（完整 64-bit 值，用于 int64 字段如 conversation_short_id）
 */
export function decodeVarint(buf, offset) {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buf.length) {
        const byte = buf[pos];
        pos++;
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0)
            break;
        shift += 7n;
        // 安全阈值：varint 最多 10 字节（64-bit）
        if (shift > 63n)
            break;
    }
    // 转换为 number（仅对 < 2^53 的值精确）
    const num = Number(result);
    return { value: num, bigValue: result, nextOffset: pos };
}
/** 读取一个字段 */
export function readField(buf, offset) {
    if (offset >= buf.length)
        return null;
    const { value: tag, nextOffset: afterTag } = decodeVarint(buf, offset);
    const field = tag >>> 3;
    const wire = (tag & 0x07);
    if (wire === WireType.Varint) {
        const { bigValue, nextOffset } = decodeVarint(buf, afterTag);
        return {
            field: { field, wire, value: bigValue, offset, length: nextOffset - offset },
            nextOffset,
        };
    }
    if (wire === WireType.LengthDelimited) {
        const { value: len, nextOffset: afterLen } = decodeVarint(buf, afterTag);
        const content = buf.subarray(afterLen, afterLen + len);
        return {
            field: {
                field,
                wire,
                value: Buffer.from(content),
                offset,
                length: afterLen + len - offset,
            },
            nextOffset: afterLen + len,
        };
    }
    if (wire === WireType.Fixed64) {
        const content = buf.subarray(afterTag, afterTag + 8);
        return {
            field: { field, wire, value: Buffer.from(content), offset, length: 9 },
            nextOffset: afterTag + 8,
        };
    }
    if (wire === WireType.Fixed32) {
        const content = buf.subarray(afterTag, afterTag + 4);
        return {
            field: { field, wire, value: Buffer.from(content), offset, length: 5 },
            nextOffset: afterTag + 4,
        };
    }
    // StartGroup/EndGroup 已废弃，跳过
    return null;
}
/** 遍历所有顶层字段 */
export function parseFields(buf) {
    const fields = [];
    let offset = 0;
    while (offset < buf.length) {
        const r = readField(buf, offset);
        if (!r)
            break;
        fields.push(r.field);
        offset = r.nextOffset;
    }
    return fields;
}
/** 读取 string field */
export function readString(field) {
    if (field.wire !== WireType.LengthDelimited)
        return '';
    return field.value.toString('utf-8');
}
/** 读取 varint field 为 number（低 53 位，向后兼容；超过 2^53 会丢失精度） */
export function readVarint(field) {
    if (field.wire !== WireType.Varint)
        return 0;
    return Number(field.value);
}
/** 读取 varint field 为 bigint（完整 64-bit 精度，用于 int64 字段如 conversation_short_id） */
export function readVarintBigint(field) {
    if (field.wire !== WireType.Varint)
        return 0n;
    return field.value;
}
/** 读取 varint field 为 string（用于 int64 字段，避免 number 精度丢失） */
export function readVarintString(field) {
    return readVarintBigint(field).toString();
}
/** 读取嵌套 message 字段（返回子 message 的字段列表） */
export function readMessage(field) {
    if (field.wire !== WireType.LengthDelimited)
        return [];
    return parseFields(field.value);
}
/** 读取 map<string,string>（同一 field 多个 entry） */
export function readMap(fields, fieldNum) {
    const result = {};
    for (const f of fields) {
        if (f.field !== fieldNum)
            continue;
        const entry = readMessage(f);
        let key = '';
        let value = '';
        for (const e of entry) {
            if (e.field === 1)
                key = readString(e);
            else if (e.field === 2)
                value = readString(e);
        }
        result[key] = value;
    }
    return result;
}
/** 按字段号查找第一个匹配的字段 */
export function findField(fields, fieldNum) {
    return fields.find((f) => f.field === fieldNum);
}
/** 按字段号查找所有匹配的字段 */
export function findFields(fields, fieldNum) {
    return fields.filter((f) => f.field === fieldNum);
}
