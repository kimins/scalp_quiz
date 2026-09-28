# scalp_quiz — KRX 일봉 → 로컬 fingerprint DB

2023~2026년 문제를 대상으로 최근 **3·4·5개 일봉의 날짜/OHLCV**를 종목과 다음 종가 등락률에 매핑합니다. Chrome 확장에는 manifest, 종목 테이블, 바이너리만 포함합니다. 원본 일봉은 개발용 캐시에만 남습니다.

Python 3.11 이상. **외부 Python 의존성·API 키·로그인 없음**. 브라우저 교차 검증에만 Node.js 20 이상이 필요합니다. 명령은 저장소 루트에서 실행하세요. 선택적으로 `python -m pip install -e .`로 설치하면 `scalp-db` 명령도 사용할 수 있습니다.

## 바로 실행

처음에는 삼성전자·SK하이닉스·넥슨게임즈로 검증합니다.

```sh
python -m scalp_db collect --codes 005930,000660,225570
python -m scalp_db build --windows 3 4 5
python scripts/verify_db.py --cache cache
node scripts/check_browser.mjs data/lookup cache 005930
python -m unittest discover -s tests -v
```

현재 상장법인 전체 수집과 기본 3일 DB 생성:

```sh
python -m scalp_db collect --start 2023-01-01 --end 2026-12-31
python -m scalp_db build --windows 3
python -m scalp_db verify --cache cache
```

기본 경로는 `cache/`, `data/lookup/`입니다. 수집은 요청당 0.4초 간격으로 순차 실행하며 수천 종목에는 시간이 걸립니다. 429/일시적 서버 오류는 최대 4회 재시도합니다. 같은 캐시/출력 폴더를 여러 프로세스에서 동시에 쓰지 마세요.

**미래 데이터는 생성하지 않습니다.** 한국시간 어제까지 공개된 일봉만 사용합니다. 장중 값 혼입을 막기 위해 당일 봉은 제외합니다. 마지막 일봉은 다음 종가가 없으므로 레코드를 만들지 않습니다. 연말 마지막 문제의 다음 종가가 이듬해에 있으면 이후 재수집 시 반영합니다.

## 소스와 커버리지

- 종목 목록: [KRX KIND 상장법인목록](https://kind.krx.co.kr/corpgeneral/corpList.do?method=loadInitPage)의 공개 Excel 다운로드(EUC-KR HTML). 동일 회사의 지역별 중복 행을 합칩니다.
- 일봉: [네이버 차트 공개 응답](https://fchart.stock.naver.com/sise.nhn?symbol=005930&timeframe=day&count=3000&requestType=0). 같은 endpoint를 [FinanceDataReader Naver reader](https://github.com/FinanceData/FinanceDataReader/blob/master/src/FinanceDataReader/naver/data.py)에서도 사용합니다.
- KIND는 **현재 상장법인** 목록입니다. 과거 상장폐지 종목, 모든 우선주·ETF·ETN을 포함하는 역사적 전체 증권 목록이 아닙니다. 기본 목록만으로 과거 문제 100% 커버리지를 보장하지 않습니다.
- 가격은 `naver-as-served`입니다. 수정주가 적용·과거 값 재조정이 있을 수 있습니다. 퀴즈가 다른 제공자, 비수정 가격, 반올림 또는 정규화된 가격을 쓰면 일치하지 않을 수 있습니다. 일치하지 않는 퀴즈 일봉은 확장에서 `미조회`로 표시합니다.
- 외부 endpoint의 정책·스키마 변경 시 오류로 보고합니다. 공개 접근과 재배포 권한은 별개이므로 DB 배포 전에 소스 이용조건을 확인하세요.

추가 종목은 UTF-8 CSV로 지정합니다. `--symbols`는 기본 목록을 **대체**하므로 필요한 종목을 모두 넣습니다. 숫자 코드 앞의 0을 보존하며 영숫자 코드도 지원합니다.

```csv
code,name
005930,삼성전자
005935,삼성전자우
225570,넥슨게임즈
```

```sh
python -m scalp_db collect --symbols my-stocks.csv --cache cache/custom
python -m scalp_db build --cache cache/custom --out data/custom --windows 3 4 5
```

CSV로 지정해도 소스가 과거 일봉을 반환해야 수집할 수 있습니다. 외부 거래소 캘린더와 누락일을 대조하지는 않습니다. `nextDate`는 소스에서 바로 다음에 있는 행의 날짜이며, 양쪽 모두 유효한 거래 일봉일 때만 기록합니다.

## 캐시·재실행·실패

- `cache/universe.json`: 날짜별 현재 상장법인 스냅샷.
- `cache/bars/<code>.json`: OHLCV, 요청 URL, 수집 시각, 종료 기준, SHA-256.
- `cache/stock-registry.json`: append 방식 종목 ID. 같은 캐시에서는 유지됩니다. 캐시를 새로 만들면 ID가 달라질 수 있으므로 동일 빌드의 종목 테이블과 바이너리를 함께 사용합니다.
- `cache/collection.json`: 마지막 실행의 종목, 성공·실패, 실제 데이터 범위, 부적격 일봉 개수. `--codes` 실행 뒤에는 해당 부분집합으로 빌드됩니다.

같은 날 같은 명령을 실행하면 성공한 캐시를 재사용하고 실패 종목을 재시도합니다. 다음 날에는 과거 수정값 반영을 위해 종목별 전체 응답을 다시 받습니다. `--refresh`는 목록과 일봉을 강제로 갱신합니다. 기본 3,000개 일봉을 요청하며 관측된 제공자 상한도 3,000개입니다. 요청 개수를 채웠는데 첫 날짜가 시작일보다 늦으면 잘린 이력으로 보고합니다. 신규 상장·소스 누락 여부를 자동 단정하지 않으므로 보고서의 first/last 범위를 확인해야 합니다.

수집 실패 시 종료 코드 1, 성공 시 0입니다. 중단된 수집은 동일 명령으로 완료한 뒤 빌드하세요. 실패 종목이 남은 빌드는 기본적으로 거부합니다. 일부만 생성하려면 `python -m scalp_db build --allow-partial`을 명시합니다. 누락 사유는 manifest의 `failedStocks`에 보존합니다.

0원, 거래량 0, OHLC 범위 오류가 있는 행은 앞뒤를 연결하지 않고 그 행을 걸치는 지문과 수익률을 제외합니다. 최신 봉의 다음날 수익률을 0으로 채우지 않습니다.

파일은 임시 파일에 쓴 뒤 교체합니다. 바이너리·종목 테이블은 내용 해시가 붙은 이름으로 저장하고 **manifest를 마지막에 교체**하여 중단 시 기존 DB를 보존합니다. 이전 빌드 파일은 자동 삭제하지 않습니다. 확장에는 현재 manifest가 참조하는 파일만 포함하세요.

## 크기·fingerprint·바이너리 포맷

레코드당 **18바이트**입니다. 3,000종목 × 1,000거래일이면 3일 인덱스는 약 54MB, 3·4·5일 모두 생성하면 약 162MB입니다(십진수, 추정). 실제 크기는 manifest에 기록합니다. 기본 3일 DB는 5일 입력에서도 마지막 3일을 잘라 조회할 수 있습니다.

정규화는 ASCII, LF 줄바꿈, 마지막 LF 포함입니다. 가격/거래량은 쉼표 없는 정수, 날짜는 `YYYY-MM-DD`, 오래된 순서입니다. 부동소수점 가격을 임의로 반올림하지 않습니다.

```text
scalp-v1|3
2025-03-12|12220|12340|11900|11950|535203
2025-03-13|11970|12220|11960|12010|398757
2025-03-14|11950|12260|11950|12220|226868
```

SHA-256 결과의 첫 8바이트를 사용합니다. 종목코드는 해시에 포함하지 않습니다. 동일 키의 레코드를 모두 저장하고 조회도 후보 배열을 반환합니다. 해시 충돌 가능성은 0이 아니므로 복수 결과를 임의로 하나 선택하지 마세요. 별도 4·5일 DB와 대조할 수 있습니다.

정수는 little endian, 키는 SHA digest 바이트 순서 그대로입니다.

| 헤더 위치 | 바이트 | 내용 |
|---|---:|---|
| 0 | 8 | ASCII `SCALPDB1` |
| 8 | 1 | 버전 1 |
| 9 | 1 | 일봉 개수 3/4/5 |
| 10 | 2 | 레코드 크기 18 |
| 12 | 4 | 레코드 개수 |

| 레코드 내부 위치 | 바이트 | 내용 |
|---|---:|---|
| 0 | 8 | fingerprint |
| 8 | 2 | stockId (uint16) |
| 10 | 2 | 마지막 날짜: 2020-01-01 기준 일수 |
| 12 | 2 | 다음 날짜: 같은 기준 |
| 14 | 4 | 다음 종가 등락률 (signed int32, basis points) |

정렬 기준은 `(fingerprint 바이트, stockId, 마지막 날짜, 다음 날짜, 수익률)`입니다. SQLite 임시 정렬로 전체 시장 레코드를 Python 메모리에 쌓지 않습니다. 검증은 window 파일 하나씩 메모리에 읽습니다.

수익률은 `(다음 종가 - 마지막 종가) / 마지막 종가 × 10000`을 정수로 반올림합니다. 정확히 절반이면 0에서 멀어지는 방향입니다. `300`은 `+3.00%`, `-69`는 `-0.69%`입니다. 가격제한폭 가정으로 값을 잘라내지 않습니다.

## Chrome 로컬 조회

### 퀴즈 페이지 확장 개발 모드

전체 시장 수집과 window=3 DB 생성이 끝난 상태에서 저장소 루트에서 한 번 실행합니다. 이 명령은 `data/lookup/manifest.json`이 가리키는 종목 테이블과 바이너리만 SHA-256으로 확인해 `extension/db/`로 복사하고, `web/lookup.mjs`도 확장에 복사합니다. 이전 빌드의 미사용 파일은 제거합니다. `extension/db/`와 복사된 모듈은 Git에 포함하지 않습니다.

```sh
python scripts/prepare_extension.py
```

Chrome에서 `chrome://extensions` → **Developer mode** → **Load unpacked** → 저장소의 `extension/` 폴더를 선택합니다. `https://scalping.kro.kr/quiz`로 이동해 퀴즈를 시작하면 각 차트 카드 오른쪽 위에 `종목명 | 다음 거래일 등락률`이 표시됩니다. 새 round를 만들거나 페이지를 새로고침해 표시가 갱신되는지 확인합니다. 확장 파일을 수정했다면 `chrome://extensions`에서 확장을 새로고침한 뒤 페이지도 새로고침하세요.

확장은 이 사이트의 `/quiz` 경로에서만 실행되며 별도 Chrome 권한이나 외부 서버 호출이 없습니다. 페이지 MAIN world의 hook은 `fetch`와 `XMLHttpRequest`의 `/api/quiz/state`, `/api/quiz/round` 응답에서 session ID, 진입가, 마지막 3개 일봉만 전달합니다. Chrome에서는 isolated content script가 DB를 로드하고, Firefox에서는 event background page가 확장 파일을 읽어 조회한 뒤 결과만 전달합니다. 두 경로 모두 여러 session이 같은 DB 인스턴스를 재사용하고 각 카드에 결과를 표시합니다. 먼저 로드된 round는 동일 출처의 `GET /api/quiz/state`로 복구합니다. 쿠키·CSRF 토큰·전체 API 응답은 전달하거나 저장하지 않습니다. 결과가 없으면 `미조회`, 여러 개면 `복수 후보`, 마지막 종가와 진입가가 다르면 `가격 불일치`로 표시합니다.

확장 단위 및 로컬 DB 통합 테스트:

```sh
node --test tests/extension.test.mjs
```

캐시와 DB가 없는 CI에서는 HAR 통합 항목만 건너뜁니다. 로컬에서 해당 두 폴더가 있으면 HAR 6개 사례를 실제 3일 DB에서 모두 조회합니다.

### Firefox for Android

Firefox의 `world: MAIN` 지원이 포함된 Firefox 128 이상을 대상으로 합니다. Manifest에는 Gecko ID, Android 호환 표시, AMO의 데이터 수집 선언(`none`)이 있습니다. Firefox의 MAIN world 지원 시작 버전과 Android용 manifest 설정은 [MDN content_scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts), [MDN browser_specific_settings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)에 맞췄습니다.

#### 기기에서 임시 테스트

임시 테스트 설치에는 서명이 필요 없습니다. Android 기기에서 USB debugging을 켜고 ADB로 개발 컴퓨터에 연결한 뒤, 저장소 루트에서 실행합니다. `web-ext`가 설치되어 있어야 합니다.

```sh
python scripts/prepare_extension.py
npx web-ext run --source-dir extension --target=firefox-android --firefox-apk org.mozilla.firefox
```

다른 설치 채널은 `--firefox-apk` 값을 `org.mozilla.firefox_beta` 또는 `org.mozilla.fenix`로 바꿉니다. `web-ext run`이 확장을 임시 로드하므로 Firefox를 종료하면 테스트 설치가 사라집니다. Android 기기 연결과 임시 설치 절차는 [Firefox Extension Workshop](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/)에 정리되어 있습니다.

#### XPI 설치용 패키지

XPI 파일을 Android Firefox에 직접 설치해 쓰려면 Mozilla 서명이 필요합니다. 공개 등록은 필수가 아니며, AMO에서 self-distribution용 unlisted 서명을 받을 수 있습니다. 패키지를 만들려면:

```sh
python scripts/package_firefox.py
```

XPI는 기본적으로 현재 manifest 버전이 포함된 `dist/scalp-quiz-lookup-<version>.xpi`에 생성됩니다. Firefox용 패키지는 MV3 event page를 포함하며, Firefox Android에서 페이지 보안 정책이 DB 파일 읽기를 막지 않도록 확장 문맥에서 DB lookup을 수행합니다. 생성된 unsigned XPI를 AMO에 unlisted/self-distribution용으로 제출해 서명받은 뒤 Android Firefox에서 파일로 설치할 수 있습니다. [Firefox Android 설치 절차](https://extensionworkshop.com/documentation/publish/install-self-distributed/). 이 저장소는 AMO 계정에 제출하거나 공개하지 않습니다.

`web/lookup.mjs`는 Web Crypto와 fetch를 사용하는 ES module입니다. manifest/종목 테이블/바이너리를 확장 `db/`에 복사합니다. 다음 예시는 확장 페이지 또는 module service worker에서 실행합니다.

```js
import {LookupDB} from './web/lookup.mjs';
const db = await LookupDB.load(chrome.runtime.getURL('db/'), 3);
// bars: [["2025-03-12", open, high, low, close, volume], ...]
const candidates = await db.lookup(bars.slice(-3));
// [{stockId, code, name, lastDate, nextDate, nextReturnBps, nextReturnPercent}]
// []이면 미조회. 여러 개면 모호한 결과로 처리.
```

로드 시 SHA-256·버전·길이를 검사합니다. 조회는 바이트 기준 이진 탐색입니다. 퀴즈의 숫자 문자열·날짜 형식은 이 스키마로 변환해야 합니다.

## 검증

```sh
# 네트워크 없이 단위/통합 테스트
python -m unittest discover -s tests -v
# 해시, 헤더, 정렬, 참조 무결성
python -m scalp_db verify
# 모든 지문/다음 날짜/수익률을 캐시에서 재계산하여 전수 대조
python -m scalp_db verify --cache cache
# 실제 JS 조회와 독립적인 정수 수익률 계산 대조
node scripts/check_browser.mjs data/lookup cache 005930
```

Windows/Linux, Python 3.11/3.13 오프라인 테스트를 GitHub Actions에 포함했습니다. 외부 소스 검증은 위 명령으로 별도 실행합니다. 최초 실행 결과: [검증 기록](docs/validation.md).
