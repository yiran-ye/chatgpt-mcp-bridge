import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedStdioClientTransport, MAX_UPSTREAM_MESSAGE_BYTES } from '../../src/mcp/stdio-client-transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const transports: ManagedStdioClientTransport[] = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(transport => transport.close())); });

async function launch(script: string) {
  const transport = new ManagedStdioClientTransport({ command: process.execPath, args: ['-e', script + ';setInterval(() => {}, 1000)'], cwd: process.cwd(), env: {} });
  const messages: JSONRPCMessage[] = []; const errors: Error[] = [];
  transport.onmessage = message => { messages.push(message); };
  transport.onerror = error => { errors.push(error); };
  transports.push(transport); await transport.start();
  return { transport, messages, errors };
}

describe('上游 stdio 空白行兼容与消息边界', () => {
  it('跳过前导及消息间空白行，并正确处理 CRLF', async () => {
    const first = { jsonrpc: '2.0', id: 1, result: { text: '中文' } };
    const second = { jsonrpc: '2.0', id: 2, result: {} };
    const text = '\n \t\r\n' + JSON.stringify(first) + '\r\n\r\n' + JSON.stringify(second) + '\n\t\n';
    const { messages, errors } = await launch('process.stdout.write(' + JSON.stringify(text) + ')');
    await vi.waitFor(() => expect(messages).toEqual([first, second]));
    expect(errors).toEqual([]);
  });
  it.each([
    "process.stdout.write('not-json-log\\n')",
    'process.stdout.write(Buffer.from([255, 10]))',
    "process.stdout.write('{\"not\":\"json-rpc\"}\\n')",
  ])('非 JSON、无效 UTF-8 或非法协议仍关闭连接：%s', async script => {
    const { transport, messages, errors } = await launch(script);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ code: 'MCP_UPSTREAM_FAILED' }); expect(messages).toEqual([]);
    await transport.close();
    await expect(transport.send({ jsonrpc: '2.0', id: 3, method: 'ping' })).rejects.toMatchObject({ code: 'MCP_UPSTREAM_UNAVAILABLE' });
  });
  it('空白行仍受原始字节上限约束', async () => {
    const { errors, messages } = await launch("process.stdout.write(' '.repeat(" + String(MAX_UPSTREAM_MESSAGE_BYTES + 1) + ") + '\\n')");
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ code: 'OUTPUT_LIMIT_EXCEEDED' }); expect(messages).toEqual([]);
  });
});
