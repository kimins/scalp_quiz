"""Anonymous public endpoints. No credentials, cookies, or API keys."""
import csv
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

from .core import validate_rows

KIND_URL = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13"
NAVER_URL = "https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count={count}&requestType=0"


def completed_day():
    # Exclude today's potentially unfinished/revised bar even after the close.
    return (datetime.now(timezone(timedelta(hours=9))).date() - timedelta(days=1)).isoformat()


def download(url, attempts=4, delay=0.4):
    for attempt in range(attempts):
        time.sleep(delay if attempt == 0 else max(delay, 2 ** attempt))
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "scalp-quiz-db/0.1", "Accept": "*/*"})
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == attempts - 1:
                raise


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell = [], [], None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.row.append("".join(self.cell).strip())
            self.cell = None
        elif tag == "tr" and self.row:
            self.rows.append(self.row)


def validate_stocks(stocks):
    result = {}
    for stock in stocks:
        code, name = stock["code"], stock["name"].strip()
        if not re.fullmatch(r"[0-9A-Z]{6}", code) or not name:
            raise ValueError(f"Invalid stock: {stock}")
        if code in result:
            raise ValueError(f"Duplicate code: {code}")
        result[code] = {"code": code, "name": name}
    if not result:
        raise ValueError("Empty stock universe")
    return [result[k] for k in sorted(result)]


def parse_kind(raw):
    parser = TableParser()
    parser.feed(raw.decode("euc-kr"))
    header = next((r for r in parser.rows if "종목코드" in r and "회사명" in r), None)
    if header is None:
        raise ValueError("KIND schema changed: missing company/code headers")
    ci, ni = header.index("종목코드"), header.index("회사명")
    stocks = []
    for row in parser.rows:
        if len(row) > max(ci, ni) and re.fullmatch(r"[0-9A-Z]{6}", row[ci]):
            stocks.append({"code": row[ci], "name": row[ni]})
    # KIND can repeat a company for multiple regional entries.
    unique = {}
    for stock in stocks:
        if stock['code'] in unique and unique[stock['code']] != stock:
            raise ValueError(f"Conflicting KIND names: {stock['code']}")
        unique[stock['code']] = stock
    return validate_stocks(list(unique.values()))


def stocks_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as handle:
        return validate_stocks(list(csv.DictReader(handle)))


def parse_naver(raw, code):
    root = ET.fromstring(raw.decode("euc-kr"))
    chart = root.find(".//chartdata")
    if chart is None or chart.get("symbol") != code:
        raise ValueError(f"Missing/wrong chart symbol: {code}")
    rows = []
    for item in chart.findall("item"):
        values = item.attrib["data"].split("|")
        if len(values) != 6 or not re.fullmatch(r"\d{8}", values[0]):
            raise ValueError(f"Invalid Naver item: {values}")
        d = values[0]
        rows.append([f"{d[:4]}-{d[4:6]}-{d[6:]}", *map(int, values[1:])])
    if not rows:
        raise ValueError(f"No bars returned: {code}")
    validate_rows(rows)
    return rows, chart.get("name", code)
