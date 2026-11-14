import { describe, expect, test } from 'vitest';
import { forgeWordsKey, toForgeWords } from '../utils/words.ts';

describe('toForgeWords', () => {
  const cases: { input: unknown; words: string[] }[] = [
    { input: 'getBy', words: ['get', 'by'] },
    { input: 'listZones', words: ['list', 'zones'] },
    { input: 'list_zones', words: ['list', 'zones'] },
    { input: 'list-zones', words: ['list', 'zones'] },
    { input: 'list.zones', words: ['list', 'zones'] },
    { input: 'list zones', words: ['list', 'zones'] },
    { input: 'LIST_ZONES', words: ['list', 'zones'] },
    { input: 'XMLDocument', words: ['xml', 'document'] },
    { input: 'ipv4Cidr', words: ['ipv4', 'cidr'] },
    { input: 'notification_url', words: ['notification', 'url'] },
    { input: 'notificationUrl', words: ['notification', 'url'] },
    { input: 'NotificationURL', words: ['notification', 'url'] },
    { input: 'URL', words: ['url'] },
    { input: 'listZonesV2', words: ['list', 'zones', 'v2'] },
    { input: 'account_id', words: ['account', 'id'] },
    { input: 'accountId', words: ['account', 'id'] },
    { input: 'account-id', words: ['account', 'id'] },
    { input: 'leading_underscore', words: ['leading', 'underscore'] },
    { input: '__double__', words: ['double'] },
    { input: 'list__zones', words: ['list', 'zones'] },
    { input: 'a---b', words: ['a', 'b'] },
    // Acronym followed by digit then uppercase: the heuristic splits before the single uppercase.
    { input: 'getIPv4', words: ['get', 'i', 'pv4'] },
    // The L→s transition triggers an acronym break before the preceding uppercase (`UR` + `Ls`).
    { input: 'URLs', words: ['ur', 'ls'] },
    // Non-ASCII alphabetic character participates like an ASCII letter.
    { input: 'cafétable', words: ['cafétable'] },
    { input: '', words: [] },
    { input: '*', words: [] },
    { input: '---', words: [] },
    { input: '  ', words: [] },
    { input: null, words: [] },
    { input: undefined, words: [] },
    { input: 42, words: [] },
    { input: {}, words: [] },
  ];
  for (const { input, words } of cases) {
    test(`${JSON.stringify(input)} → [${words.join(', ')}]`, () => {
      expect(toForgeWords(input)).toEqual(words);
    });
  }

  test('two names with the same word list produce the same key', () => {
    expect(forgeWordsKey('notification_url')).toBe(forgeWordsKey('notificationUrl'));
    expect(forgeWordsKey('listZones')).toBe(forgeWordsKey('LIST_ZONES'));
  });

  test('names with different word lists produce different keys', () => {
    expect(forgeWordsKey('abc')).not.toBe(forgeWordsKey('ab'));
    expect(forgeWordsKey('list_all_zones')).not.toBe(forgeWordsKey('list_zones'));
    // Separator `\u0000` prevents "a" + "bc" ≠ "ab" + "c" from colliding.
    expect(forgeWordsKey('a_bc')).not.toBe(forgeWordsKey('ab_c'));
  });
});
