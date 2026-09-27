import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scalp_db.core import (HEADER, RECORD, canonical, fingerprint, json_bytes,
                           records_for, return_bps, validate_rows)
from scalp_db.pipeline import build, collect, find_records, sha, verify
from scalp_db.sources import parse_kind, parse_naver, stocks_csv


def bars():
    return [[f"2023-01-{d:02d}", 100, 120, 90, 100 + d, 12345] for d in range(2, 10)]


class CoreTests(unittest.TestCase):
    def test_canonical(self):
        rows = bars()[:3]
        self.assertTrue(canonical(rows).startswith(b"scalp-v1|3\n2023-01-02|"))
        self.assertEqual(len(fingerprint(rows)), 8)
        changed = [r[:] for r in rows]
        changed[2][-1] += 1
        self.assertNotEqual(fingerprint(rows), fingerprint(changed))

    def test_invalid_rows(self):
        for rows in [bars()[::-1], [bars()[0]] * 3, [["2023-02-30", 1, 1, 1, 1, 1]],
                     [["2023-01-01", 1.0, 1, 1, 1, 1]]]:
            with self.assertRaises(ValueError):
                validate_rows(rows)
        with self.assertRaises(ValueError):
            fingerprint(bars()[:2])

    def test_return_rounding_and_extreme(self):
        self.assertEqual(return_bps(100, 103), 300)
        self.assertEqual(return_bps(20000, 20001), 1)
        self.assertEqual(return_bps(20000, 19999), -1)
        self.assertEqual(return_bps(1, 100), 990000)

    def test_boundaries_next_day_and_unknown(self):
        rows = bars()
        records = list(records_for(rows, 0, 3, "2023-01-04", "2023-01-04"))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0][-1], return_bps(104, 105))
        self.assertEqual(len(list(records_for(rows, 0, 3, "2023-01-09", "2023-01-09"))), 0)

    def test_invalid_bar_is_barrier(self):
        rows = bars()[:5]
        rows[2][-1] = 0
        self.assertEqual(list(records_for(rows, 0, 3, "2023-01-01", "2023-12-31")), [])
        rows[2][-1] = 100
        rows[2][2] = 1  # invalid high; do not stitch around it
        self.assertEqual(list(records_for(rows, 0, 3, "2023-01-01", "2023-12-31")), [])

    def test_source_parsers(self):
        html = '<table><tr><th>회사명</th><th>종목코드</th></tr>' + '<tr><td>테스트</td><td>0001A0</td></tr>' * 2 + '</table>'
        self.assertEqual(parse_kind(html.encode('euc-kr')), [{"code": "0001A0", "name": "테스트"}])
        xml = b'<protocol><chartdata symbol="005930" name="test"><item data="20230102|100|110|90|105|50" /></chartdata></protocol>'
        self.assertEqual(parse_naver(xml, "005930")[0][0][4], 105)
        with self.assertRaises(ValueError):
            parse_naver(xml, "000660")
        with self.assertRaises(ValueError):
            parse_kind(b'<html>error</html>')


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / 'cache'
        (self.cache / 'bars').mkdir(parents=True)
        self.rows = bars()
        self.stock = {"code": "005930", "name": "삼성전자", "stockId": 0,
                      "cache": "bars/005930.json", "rowsSha256": sha(json_bytes(self.rows))}
        (self.cache / self.stock['cache']).write_bytes(json_bytes({"code": "005930", "rows": self.rows}))
        self.report = {"complete": True, "stocks": [self.stock], "failures": [],
                       "requestedStart": "2023-01-01", "requestedEnd": "2026-12-31",
                       "effectiveEnd": "2026-09-26", "universeSource": "synthetic fixture"}
        self.save_report()
        self.args = argparse.Namespace(cache=str(self.cache), out=str(self.root / 'out'), windows=[3, 4, 5], allow_partial=False)

    def save_report(self):
        (self.cache / 'collection.json').write_bytes(json_bytes(self.report))

    def test_build_verify_reproducible(self):
        first = build(self.args)
        self.assertEqual(verify(self.args)['verifiedRecords'], 12)
        self.assertEqual(first, build(self.args))
        self.assertEqual(RECORD.size, 18)

    def test_corruption_detected(self):
        manifest = build(self.args)
        path = Path(self.args.out) / manifest['files'][0]['file']
        path.write_bytes(path.read_bytes()[:-1])
        with self.assertRaises(ValueError):
            verify(self.args)

    def test_source_tampering_detected(self):
        build(self.args)
        self.rows[0][-1] += 1
        (self.cache / self.stock['cache']).write_bytes(json_bytes({"code": "005930", "rows": self.rows}))
        with self.assertRaises(ValueError):
            verify(self.args)

    def test_interrupted_and_partial_blocked(self):
        self.report['complete'] = False
        self.save_report()
        with self.assertRaises(ValueError):
            build(self.args)
        self.report['complete'] = True
        self.report['failures'] = [{'code': '000660', 'error': 'timeout'}]
        self.save_report()
        with self.assertRaises(ValueError):
            build(self.args)
        self.args.allow_partial = True
        self.assertTrue(build(self.args)['failedStocks'])

    def test_collisions_preserved(self):
        with patch('scalp_db.core.fingerprint', return_value=b'12345678'):
            manifest = build(self.args)
            self.assertEqual(verify(self.args)['verifiedRecords'], 12)
        entry = manifest['files'][0]
        data = (Path(self.args.out) / entry['file']).read_bytes()
        self.assertEqual(len(find_records(data, b'12345678')), 5)
        self.assertEqual(find_records(data, b'00000000'), [])
        self.assertEqual(entry['duplicateKeys'], 4)

    def test_collect_resume_without_network(self):
        csv = self.root / 'stocks.csv'
        csv.write_text('code,name\n005930,삼성전자\n', encoding='utf-8')
        xml = ('<protocol><chartdata symbol="005930">' + ''.join(
            '<item data="' + r[0].replace('-', '') + '|' + '|'.join(map(str, r[1:])) + '" />'
            for r in self.rows) + '</chartdata></protocol>').encode()
        args = argparse.Namespace(cache=str(self.root / 'fresh'), start='2023-01-01', end='2026-12-31',
                                  symbols=str(csv), codes=None, refresh=False, count=3000, delay=0)
        with patch('scalp_db.pipeline.download', return_value=xml) as network:
            report = collect(args)
            self.assertFalse(report['failures'])
            self.assertEqual(network.call_count, 1)
        with patch('scalp_db.pipeline.download', side_effect=AssertionError('Network should not run')):
            report = collect(args)
            self.assertFalse(report['failures'])
        self.assertEqual(report['stocks'][0]['stockId'], 0)


if __name__ == '__main__':
    unittest.main()
