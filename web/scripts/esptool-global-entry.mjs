import { ESPLoader, Transport } from "esptool-js";
import SparkMD5 from "spark-md5";

function md5(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return SparkMD5.ArrayBuffer.hash(buffer);
}

globalThis.CRazyLinkEspToolLib = { ESPLoader, Transport, md5 };
