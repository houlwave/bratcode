
// ─── Разбор кадров text/event-stream ─────────────────────────────────────────
//
// Genspark отдаёт ответ агента как SSE: последовательность записей, разделённых
// пустой строкой, где полезная нагрузка лежит в строках `data:`.
//
//     data: {"type":"message_field_delta","delta":"Прив", ...}\n\n
//
// Тонкости, из-за которых наивный `split('\n\n')` ломается на живом потоке:
//
//   1) Кадр может прийти разорванным между TCP-чанками — ждём полный
//      разделитель, остаток держим в буфере.
//   2) Разделитель бывает и `\n\n`, и `\r\n\r\n` (через прокси).
//   3) Одна запись может содержать НЕСКОЛЬКО строк `data:` — по спецификации
//      они склеиваются через `\n` и только потом парсятся как один JSON.
//   4) Строки `event:`, `id:`, `retry:` и комментарии `: keepalive` — служебные,
//      их нужно пропускать, а не пытаться парсить.
//   5) UTF-8 многобайтовые символы могут разрезаться на границе чанка —
//      поэтому декодируем потоково (StringDecoder), а не `chunk.toString()`.
//      Именно отсюда брались «кракозябры» посреди русского текста.

import { StringDecoder } from 'node:string_decoder';

const SEPARATOR_RX = /\r?\n\r?\n/;

/**
 * Инкрементальный парсер SSE.
 *
 * @param {(payload: string) => void} onData  вызывается на каждую собранную
 *   запись с её склеенным `data`-телом (без разбора JSON — это задача выше).
 */
function createSseParser(onData) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  /** Разобрать одну завершённую запись. */
  const handleRecord = (record) => {
    if (!record) return;
    const dataLines = [];
    for (const rawLine of record.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      // Комментарий-пинг: `: keepalive`. Соединение жи��о, данных нет.
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field !== 'data') continue; // event/id/retry нам не нужны
      let value = colon === -1 ? '' : line.slice(colon + 1);
      // По спецификации съедается ровно один ведущий пробел.
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    if (!payload || payload === '[DONE]') return;
    onData(payload);
  };

  return {
    /** Скормить очередной сетевой чанк (Buffer или строку). */
    push(chunk) {
      buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      let m;
      while ((m = SEPARATOR_RX.exec(buffer)) !== null) {
        const record = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        if (record.trim()) handleRecord(record);
      }
    },
    /** Поток закончился — дожать незавершённый хвост. */
    end() {
      buffer += decoder.end();
      if (buffer.trim()) handleRecord(buffer);
      buffer = '';
    },
  };
}

export { createSseParser };
