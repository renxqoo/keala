# CPU Profile

| Duration | Samples | Interval | Functions |
| -------- | ------- | -------- | --------- |
| 5.00s    | 4230    | 1.0ms    | 58        |

**Top 10:** `Response` 16.7%, `splitSegments` 15.3%, `matchPattern` 14.6%, `handle` 6.5%, `getPath` 6.1%, `splitSegments` 4.6%, `matchRoute` 4.2%, `matchPattern` 3.3%, `decodeSegment` 2.7%, `createBoundContext` 2.5%

## Hot Functions (Self Time)

| Self% |    Self | Total% |   Total | Function             | Location                                                               |
| ----: | ------: | -----: | ------: | -------------------- | ---------------------------------------------------------------------- |
| 16.7% | 836.2ms |  16.7% | 836.2ms | `Response`           | `[native code]`                                                        |
| 15.3% | 770.3ms |  15.3% | 770.3ms | `splitSegments`      | `/Users/wrr/work/bun-koa/src/router/trie.ts:245`                       |
| 14.6% | 731.3ms |  14.6% | 731.3ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:219`                       |
|  6.5% | 325.3ms |   6.5% | 325.3ms | `handle`             | `/Users/wrr/work/bun-koa/src/core/app.ts:318`                          |
|  6.1% | 309.5ms |   6.1% | 309.5ms | `getPath`            | `/Users/wrr/work/bun-koa/src/utils/url.ts:16`                          |
|  4.6% | 234.4ms |   4.6% | 234.4ms | `splitSegments`      | `/Users/wrr/work/bun-koa/src/router/trie.ts:246`                       |
|  4.2% | 212.8ms |   4.2% | 212.8ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:481`                     |
|  3.3% | 166.6ms |   3.3% | 166.6ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:218`                       |
|  2.7% | 136.1ms |   2.7% | 136.1ms | `decodeSegment`      | `/Users/wrr/work/bun-koa/src/router/pattern.ts:30`                     |
|  2.5% | 127.0ms |   2.5% | 127.0ms | `createBoundContext` | `/Users/wrr/work/bun-koa/src/core/context/context.ts:217`              |
|  2.2% | 111.7ms |   2.2% | 111.7ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:454`                     |
|  2.1% | 107.7ms |   2.1% | 107.7ms | `getSearch`          | `/Users/wrr/work/bun-koa/src/utils/url.ts:35`                          |
|  1.8% |  92.2ms |   1.8% |  92.2ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:459`                     |
|  1.8% |  92.1ms |   1.8% |  92.1ms | `getPath`            | `/Users/wrr/work/bun-koa/src/utils/url.ts:15`                          |
|  1.6% |  82.6ms |   1.6% |  82.6ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:480`                     |
|  1.6% |  81.8ms |   1.6% |  81.8ms | `getSearch`          | `/Users/wrr/work/bun-koa/src/utils/url.ts:33`                          |
|  1.4% |  73.8ms |   1.4% |  73.8ms | `sourceMethod`       | `/Users/wrr/work/bun-koa/src/core/request-source.ts:37`                |
|  1.3% |  69.3ms |   1.3% |  69.3ms | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:323`                     |
|  1.3% |  68.0ms |   1.3% |  68.0ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:478`                     |
|  1.0% |  50.3ms |  89.9% |   4.50s | `#serve`             | `/Users/wrr/work/bun-koa/src/core/app.ts:351`                          |
|  0.8% |  44.7ms |   0.8% |  44.7ms | `getPath`            | `/Users/wrr/work/bun-koa/src/utils/url.ts:27`                          |
|  0.7% |  37.8ms |   0.7% |  37.8ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:479`                     |
|  0.7% |  36.4ms |  93.3% |   4.67s | `handle`             | `/Users/wrr/work/bun-koa/src/core/app.ts:317`                          |
|  0.6% |  34.0ms |   0.6% |  34.0ms | `dispatchDirect`     | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:264`                     |
|  0.5% |  29.2ms |  17.3% | 869.2ms | `textResponse`       | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts:43`                 |
|  0.5% |  26.8ms |  54.6% |   2.73s | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:310`                     |
|  0.4% |  23.4ms |   0.4% |  23.4ms | `sourceUrl`          | `/Users/wrr/work/bun-koa/src/core/request-source.ts:39`                |
|  0.3% |  15.7ms |   0.3% |  15.7ms | `recordOf`           | `/Users/wrr/work/bun-koa/src/router/trie.ts:237`                       |
|  0.3% |  15.0ms |   0.3% |  15.0ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:144`                       |
|  0.2% |  10.3ms |   0.2% |  10.3ms | `pushVariant`        | `/Users/wrr/work/bun-koa/src/router/trie.ts:125`                       |
|  0.1% |   9.3ms |   0.1% |   9.3ms | `sugarText`          | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts`                    |
|  0.1% |   6.3ms |   0.1% |   6.3ms | `compilePattern`     | `/Users/wrr/work/bun-koa/src/router/pattern.ts`                        |
|  0.1% |   5.8ms |   0.1% |   5.8ms | `pushVariant`        | `/Users/wrr/work/bun-koa/src/router/trie.ts:123`                       |
|  0.1% |   5.1ms |   0.1% |   5.1ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:141`                       |
|  0.1% |   5.0ms |   0.1% |   5.0ms | `recordOf`           | `/Users/wrr/work/bun-koa/src/router/trie.ts:231`                       |
|  0.0% |   4.9ms |  18.2% | 911.4ms | `dispatchDirect`     | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:237`                     |
|  0.0% |   3.7ms |   0.0% |   3.7ms | `directResponse`     | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts:35`                 |
|  0.0% |   3.3ms |   0.0% |   3.3ms | `#serve`             | `/Users/wrr/work/bun-koa/src/core/app.ts:342`                          |
|  0.0% |   1.3ms |  99.8% |   4.99s | `(module)`           | `/Users/wrr/work/bun-koa/bench/route-shootout/diag/profile-loop.ts:16` |
|  0.0% |   1.3ms |   0.0% |   1.3ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts`                           |
|  0.0% |   1.2ms |  20.1% |   1.00s | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:139`                       |
|  0.0% |   1.2ms |   0.4% |  22.0ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:148`                       |
|  0.0% |   966us |   0.0% |   966us | `#serve`             | `/Users/wrr/work/bun-koa/src/core/app.ts:366`                          |
|  0.0% |   904us |   0.0% |   904us | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:224`                       |

## Call Tree (Total Time)

| Total% |   Total | Self% |    Self | Function             | Location                                                               |
| -----: | ------: | ----: | ------: | -------------------- | ---------------------------------------------------------------------- |
|  99.8% |   4.99s |  0.0% |   1.3ms | `(module)`           | `/Users/wrr/work/bun-koa/bench/route-shootout/diag/profile-loop.ts:16` |
|  93.3% |   4.67s |  0.7% |  36.4ms | `handle`             | `/Users/wrr/work/bun-koa/src/core/app.ts:317`                          |
|  89.9% |   4.50s |  1.0% |  50.3ms | `#serve`             | `/Users/wrr/work/bun-koa/src/core/app.ts:351`                          |
|  54.6% |   2.73s |  0.5% |  26.8ms | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:310`                     |
|  20.1% |   1.00s |  0.0% |   1.2ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:139`                       |
|  18.8% | 944.2ms |  0.0% |     0us | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:329`                     |
|  18.2% | 911.4ms |  0.0% |   4.9ms | `dispatchDirect`     | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:237`                     |
|  17.3% | 869.2ms |  0.0% |     0us | `sugarText`          | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts:190`                |
|  17.3% | 869.2ms |  0.5% |  29.2ms | `textResponse`       | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts:43`                 |
|  16.7% | 836.2ms | 16.7% | 836.2ms | `Response`           | `[native code]`                                                        |
|  15.3% | 770.3ms | 15.3% | 770.3ms | `splitSegments`      | `/Users/wrr/work/bun-koa/src/router/trie.ts:245`                       |
|  14.6% | 731.3ms | 14.6% | 731.3ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:219`                       |
|   8.9% | 446.5ms |  0.0% |     0us | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:303`                     |
|   6.5% | 325.3ms |  6.5% | 325.3ms | `handle`             | `/Users/wrr/work/bun-koa/src/core/app.ts:318`                          |
|   6.1% | 309.5ms |  6.1% | 309.5ms | `getPath`            | `/Users/wrr/work/bun-koa/src/utils/url.ts:16`                          |
|   4.6% | 234.4ms |  4.6% | 234.4ms | `splitSegments`      | `/Users/wrr/work/bun-koa/src/router/trie.ts:246`                       |
|   4.2% | 212.8ms |  4.2% | 212.8ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:481`                     |
|   3.7% | 189.6ms |  0.0% |     0us | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:309`                     |
|   3.3% | 166.6ms |  3.3% | 166.6ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:218`                       |
|   2.7% | 136.1ms |  0.0% |     0us | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:202`                       |
|   2.7% | 136.1ms |  2.7% | 136.1ms | `decodeSegment`      | `/Users/wrr/work/bun-koa/src/router/pattern.ts:30`                     |
|   2.5% | 127.0ms |  2.5% | 127.0ms | `createBoundContext` | `/Users/wrr/work/bun-koa/src/core/context/context.ts:217`              |
|   2.5% | 127.0ms |  0.0% |     0us | `#serve`             | `/Users/wrr/work/bun-koa/src/core/app.ts:348`                          |
|   2.2% | 111.7ms |  2.2% | 111.7ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:454`                     |
|   2.1% | 107.7ms |  2.1% | 107.7ms | `getSearch`          | `/Users/wrr/work/bun-koa/src/utils/url.ts:35`                          |
|   1.8% |  92.2ms |  1.8% |  92.2ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:459`                     |
|   1.8% |  92.1ms |  1.8% |  92.1ms | `getPath`            | `/Users/wrr/work/bun-koa/src/utils/url.ts:15`                          |
|   1.6% |  82.6ms |  1.6% |  82.6ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:480`                     |
|   1.6% |  81.8ms |  1.6% |  81.8ms | `getSearch`          | `/Users/wrr/work/bun-koa/src/utils/url.ts:33`                          |
|   1.4% |  73.8ms |  1.4% |  73.8ms | `sourceMethod`       | `/Users/wrr/work/bun-koa/src/core/request-source.ts:37`                |
|   1.3% |  69.3ms |  1.3% |  69.3ms | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:323`                     |
|   1.3% |  68.0ms |  1.3% |  68.0ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:478`                     |
|   0.9% |  45.9ms |  0.0% |     0us | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:319`                     |
|   0.8% |  44.7ms |  0.8% |  44.7ms | `getPath`            | `/Users/wrr/work/bun-koa/src/utils/url.ts:27`                          |
|   0.7% |  37.8ms |  0.7% |  37.8ms | `matchRoute`         | `/Users/wrr/work/bun-koa/src/router/router.ts:479`                     |
|   0.6% |  34.0ms |  0.6% |  34.0ms | `dispatchDirect`     | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:264`                     |
|   0.5% |  27.8ms |  0.0% |     0us | `sugarText`          | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts:187`                |
|   0.4% |  23.4ms |  0.4% |  23.4ms | `sourceUrl`          | `/Users/wrr/work/bun-koa/src/core/request-source.ts:39`                |
|   0.4% |  23.4ms |  0.0% |     0us | `dispatchRequest`    | `/Users/wrr/work/bun-koa/src/core/dispatch.ts:302`                     |
|   0.4% |  22.0ms |  0.0% |   1.2ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:148`                       |
|   0.3% |  16.1ms |  0.0% |     0us | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:209`                       |
|   0.3% |  15.7ms |  0.3% |  15.7ms | `recordOf`           | `/Users/wrr/work/bun-koa/src/router/trie.ts:237`                       |
|   0.3% |  15.0ms |  0.3% |  15.0ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:144`                       |
|   0.2% |  10.3ms |  0.2% |  10.3ms | `pushVariant`        | `/Users/wrr/work/bun-koa/src/router/trie.ts:125`                       |
|   0.1% |   9.3ms |  0.1% |   9.3ms | `sugarText`          | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts`                    |
|   0.1% |   6.3ms |  0.1% |   6.3ms | `compilePattern`     | `/Users/wrr/work/bun-koa/src/router/pattern.ts`                        |
|   0.1% |   6.3ms |  0.0% |     0us | `registerDef`        | `/Users/wrr/work/bun-koa/src/router/router.ts:346`                     |
|   0.1% |   6.3ms |  0.0% |     0us | `bindDef`            | `/Users/wrr/work/bun-koa/src/router/router.ts:251`                     |
|   0.1% |   6.3ms |  0.0% |     0us | `(module)`           | `/Users/wrr/work/bun-koa/bench/route-shootout/diag/profile-loop.ts:11` |
|   0.1% |   6.3ms |  0.0% |     0us | `routeShortcut`      | `/Users/wrr/work/bun-koa/src/core/registration.ts:45`                  |
|   0.1% |   5.8ms |  0.1% |   5.8ms | `pushVariant`        | `/Users/wrr/work/bun-koa/src/router/trie.ts:123`                       |
|   0.1% |   5.1ms |  0.1% |   5.1ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:141`                       |
|   0.1% |   5.0ms |  0.1% |   5.0ms | `recordOf`           | `/Users/wrr/work/bun-koa/src/router/trie.ts:231`                       |
|   0.0% |   3.7ms |  0.0% |   3.7ms | `directResponse`     | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts:35`                 |
|   0.0% |   3.3ms |  0.0% |   3.3ms | `#serve`             | `/Users/wrr/work/bun-koa/src/core/app.ts:342`                          |
|   0.0% |   1.3ms |  0.0% |   1.3ms | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts`                           |
|   0.0% |   966us |  0.0% |   966us | `#serve`             | `/Users/wrr/work/bun-koa/src/core/app.ts:366`                          |
|   0.0% |   904us |  0.0% |   904us | `matchPattern`       | `/Users/wrr/work/bun-koa/src/router/trie.ts:224`                       |

## Function Details

### `Response`

`[native code]` | Self: 16.7% (836.2ms) | Total: 16.7% (836.2ms) | Samples: 710

**Called by:**

- `textResponse` (710)

### `splitSegments`

`/Users/wrr/work/bun-koa/src/router/trie.ts:245` | Self: 15.3% (770.3ms) | Total: 15.3% (770.3ms) | Samples: 658

**Called by:**

- `matchPattern` (658)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:219` | Self: 14.6% (731.3ms) | Total: 14.6% (731.3ms) | Samples: 622

**Called by:**

- `dispatchRequest` (622)

### `handle`

`/Users/wrr/work/bun-koa/src/core/app.ts:318` | Self: 6.5% (325.3ms) | Total: 6.5% (325.3ms) | Samples: 272

**Called by:**

- `(module)` (272)

### `getPath`

`/Users/wrr/work/bun-koa/src/utils/url.ts:16` | Self: 6.1% (309.5ms) | Total: 6.1% (309.5ms) | Samples: 263

**Called by:**

- `dispatchRequest` (263)

### `splitSegments`

`/Users/wrr/work/bun-koa/src/router/trie.ts:246` | Self: 4.6% (234.4ms) | Total: 4.6% (234.4ms) | Samples: 199

**Called by:**

- `matchPattern` (199)

### `matchRoute`

`/Users/wrr/work/bun-koa/src/router/router.ts:481` | Self: 4.2% (212.8ms) | Total: 4.2% (212.8ms) | Samples: 176

**Called by:**

- `dispatchRequest` (176)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:218` | Self: 3.3% (166.6ms) | Total: 3.3% (166.6ms) | Samples: 140

**Called by:**

- `dispatchRequest` (140)

### `decodeSegment`

`/Users/wrr/work/bun-koa/src/router/pattern.ts:30` | Self: 2.7% (136.1ms) | Total: 2.7% (136.1ms) | Samples: 113

**Called by:**

- `matchPattern` (113)

### `createBoundContext`

`/Users/wrr/work/bun-koa/src/core/context/context.ts:217` | Self: 2.5% (127.0ms) | Total: 2.5% (127.0ms) | Samples: 109

**Called by:**

- `#serve` (109)

### `matchRoute`

`/Users/wrr/work/bun-koa/src/router/router.ts:454` | Self: 2.2% (111.7ms) | Total: 2.2% (111.7ms) | Samples: 93

**Called by:**

- `dispatchRequest` (93)

### `getSearch`

`/Users/wrr/work/bun-koa/src/utils/url.ts:35` | Self: 2.1% (107.7ms) | Total: 2.1% (107.7ms) | Samples: 89

**Called by:**

- `dispatchRequest` (89)

### `matchRoute`

`/Users/wrr/work/bun-koa/src/router/router.ts:459` | Self: 1.8% (92.2ms) | Total: 1.8% (92.2ms) | Samples: 80

**Called by:**

- `dispatchRequest` (80)

### `getPath`

`/Users/wrr/work/bun-koa/src/utils/url.ts:15` | Self: 1.8% (92.1ms) | Total: 1.8% (92.1ms) | Samples: 80

**Called by:**

- `dispatchRequest` (80)

### `matchRoute`

`/Users/wrr/work/bun-koa/src/router/router.ts:480` | Self: 1.6% (82.6ms) | Total: 1.6% (82.6ms) | Samples: 70

**Called by:**

- `dispatchRequest` (70)

### `getSearch`

`/Users/wrr/work/bun-koa/src/utils/url.ts:33` | Self: 1.6% (81.8ms) | Total: 1.6% (81.8ms) | Samples: 66

**Called by:**

- `dispatchRequest` (66)

### `sourceMethod`

`/Users/wrr/work/bun-koa/src/core/request-source.ts:37` | Self: 1.4% (73.8ms) | Total: 1.4% (73.8ms) | Samples: 64

**Called by:**

- `dispatchRequest` (40)
- `sugarText` (24)

### `dispatchRequest`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:323` | Self: 1.3% (69.3ms) | Total: 1.3% (69.3ms) | Samples: 58

**Called by:**

- `#serve` (58)

### `matchRoute`

`/Users/wrr/work/bun-koa/src/router/router.ts:478` | Self: 1.3% (68.0ms) | Total: 1.3% (68.0ms) | Samples: 58

**Called by:**

- `dispatchRequest` (58)

### `#serve`

`/Users/wrr/work/bun-koa/src/core/app.ts:351` | Self: 1.0% (50.3ms) | Total: 89.9% (4.50s) | Samples: 44

**Called by:**

- `handle` (3814)

**Calls:**

- `dispatchRequest` (2316)
- `dispatchRequest` (800)
- `dispatchRequest` (381)
- `dispatchRequest` (155)
- `dispatchRequest` (58)
- `dispatchRequest` (40)
- `dispatchRequest` (19)
- `dispatchDirect` (1)

### `getPath`

`/Users/wrr/work/bun-koa/src/utils/url.ts:27` | Self: 0.8% (44.7ms) | Total: 0.8% (44.7ms) | Samples: 38

**Called by:**

- `dispatchRequest` (38)

### `matchRoute`

`/Users/wrr/work/bun-koa/src/router/router.ts:479` | Self: 0.7% (37.8ms) | Total: 0.7% (37.8ms) | Samples: 32

**Called by:**

- `dispatchRequest` (32)

### `handle`

`/Users/wrr/work/bun-koa/src/core/app.ts:317` | Self: 0.7% (36.4ms) | Total: 93.3% (4.67s) | Samples: 29

**Called by:**

- `(module)` (3956)

**Calls:**

- `#serve` (3814)
- `#serve` (109)
- `#serve` (3)
- `#serve` (1)

### `dispatchDirect`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:264` | Self: 0.6% (34.0ms) | Total: 0.6% (34.0ms) | Samples: 29

**Called by:**

- `dispatchRequest` (29)

### `textResponse`

`/Users/wrr/work/bun-koa/src/core/context/sugar.ts:43` | Self: 0.5% (29.2ms) | Total: 17.3% (869.2ms) | Samples: 24

**Called by:**

- `sugarText` (737)

**Calls:**

- `Response` (710)
- `directResponse` (3)

### `dispatchRequest`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:310` | Self: 0.5% (26.8ms) | Total: 54.6% (2.73s) | Samples: 22

**Called by:**

- `#serve` (2316)

**Calls:**

- `matchPattern` (858)
- `matchPattern` (622)
- `matchRoute` (176)
- `matchPattern` (140)
- `matchPattern` (113)
- `matchRoute` (93)
- `matchRoute` (80)
- `matchRoute` (70)
- `matchRoute` (58)
- `matchRoute` (32)
- `matchPattern` (19)
- `matchPattern` (14)
- `matchPattern` (13)
- `matchPattern` (4)
- `matchPattern` (1)
- `matchPattern` (1)

### `sourceUrl`

`/Users/wrr/work/bun-koa/src/core/request-source.ts:39` | Self: 0.4% (23.4ms) | Total: 0.4% (23.4ms) | Samples: 19

**Called by:**

- `dispatchRequest` (19)

### `recordOf`

`/Users/wrr/work/bun-koa/src/router/trie.ts:237` | Self: 0.3% (15.7ms) | Total: 0.3% (15.7ms) | Samples: 14

**Called by:**

- `matchPattern` (14)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:144` | Self: 0.3% (15.0ms) | Total: 0.3% (15.0ms) | Samples: 13

**Called by:**

- `dispatchRequest` (13)

### `pushVariant`

`/Users/wrr/work/bun-koa/src/router/trie.ts:125` | Self: 0.2% (10.3ms) | Total: 0.2% (10.3ms) | Samples: 9

**Called by:**

- `matchPattern` (9)

### `sugarText`

`/Users/wrr/work/bun-koa/src/core/context/sugar.ts` | Self: 0.1% (9.3ms) | Total: 0.1% (9.3ms) | Samples: 7

**Called by:**

- `dispatchDirect` (7)

### `compilePattern`

`/Users/wrr/work/bun-koa/src/router/pattern.ts` | Self: 0.1% (6.3ms) | Total: 0.1% (6.3ms) | Samples: 1

**Called by:**

- `bindDef` (1)

### `pushVariant`

`/Users/wrr/work/bun-koa/src/router/trie.ts:123` | Self: 0.1% (5.8ms) | Total: 0.1% (5.8ms) | Samples: 5

**Called by:**

- `matchPattern` (5)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:141` | Self: 0.1% (5.1ms) | Total: 0.1% (5.1ms) | Samples: 4

**Called by:**

- `dispatchRequest` (4)

### `recordOf`

`/Users/wrr/work/bun-koa/src/router/trie.ts:231` | Self: 0.1% (5.0ms) | Total: 0.1% (5.0ms) | Samples: 4

**Called by:**

- `matchPattern` (4)

### `dispatchDirect`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:237` | Self: 0.0% (4.9ms) | Total: 18.2% (911.4ms) | Samples: 4

**Called by:**

- `dispatchRequest` (771)
- `#serve` (1)

**Calls:**

- `sugarText` (737)
- `sugarText` (24)
- `sugarText` (7)

### `directResponse`

`/Users/wrr/work/bun-koa/src/core/context/sugar.ts:35` | Self: 0.0% (3.7ms) | Total: 0.0% (3.7ms) | Samples: 3

**Called by:**

- `textResponse` (3)

### `#serve`

`/Users/wrr/work/bun-koa/src/core/app.ts:342` | Self: 0.0% (3.3ms) | Total: 0.0% (3.3ms) | Samples: 3

**Called by:**

- `handle` (3)

### `(module)`

`/Users/wrr/work/bun-koa/bench/route-shootout/diag/profile-loop.ts:16` | Self: 0.0% (1.3ms) | Total: 99.8% (4.99s) | Samples: 1

**Calls:**

- `handle` (3956)
- `handle` (272)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**

- `dispatchRequest` (1)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:139` | Self: 0.0% (1.2ms) | Total: 20.1% (1.00s) | Samples: 1

**Called by:**

- `dispatchRequest` (858)

**Calls:**

- `splitSegments` (658)
- `splitSegments` (199)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:148` | Self: 0.0% (1.2ms) | Total: 0.4% (22.0ms) | Samples: 1

**Called by:**

- `dispatchRequest` (19)

**Calls:**

- `recordOf` (14)
- `recordOf` (4)

### `#serve`

`/Users/wrr/work/bun-koa/src/core/app.ts:366` | Self: 0.0% (966us) | Total: 0.0% (966us) | Samples: 1

**Called by:**

- `handle` (1)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:224` | Self: 0.0% (904us) | Total: 0.0% (904us) | Samples: 1

**Called by:**

- `dispatchRequest` (1)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:202` | Self: 0.0% (0us) | Total: 2.7% (136.1ms) | Samples: 0

**Called by:**

- `dispatchRequest` (113)

**Calls:**

- `decodeSegment` (113)

### `sugarText`

`/Users/wrr/work/bun-koa/src/core/context/sugar.ts:190` | Self: 0.0% (0us) | Total: 17.3% (869.2ms) | Samples: 0

**Called by:**

- `dispatchDirect` (737)

**Calls:**

- `textResponse` (737)

### `bindDef`

`/Users/wrr/work/bun-koa/src/router/router.ts:251` | Self: 0.0% (0us) | Total: 0.1% (6.3ms) | Samples: 0

**Called by:**

- `registerDef` (1)

**Calls:**

- `compilePattern` (1)

### `#serve`

`/Users/wrr/work/bun-koa/src/core/app.ts:348` | Self: 0.0% (0us) | Total: 2.5% (127.0ms) | Samples: 0

**Called by:**

- `handle` (109)

**Calls:**

- `createBoundContext` (109)

### `registerDef`

`/Users/wrr/work/bun-koa/src/router/router.ts:346` | Self: 0.0% (0us) | Total: 0.1% (6.3ms) | Samples: 0

**Called by:**

- `routeShortcut` (1)

**Calls:**

- `bindDef` (1)

### `routeShortcut`

`/Users/wrr/work/bun-koa/src/core/registration.ts:45` | Self: 0.0% (0us) | Total: 0.1% (6.3ms) | Samples: 0

**Called by:**

- `(module)` (1)

**Calls:**

- `registerDef` (1)

### `dispatchRequest`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:309` | Self: 0.0% (0us) | Total: 3.7% (189.6ms) | Samples: 0

**Called by:**

- `#serve` (155)

**Calls:**

- `getSearch` (89)
- `getSearch` (66)

### `dispatchRequest`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:302` | Self: 0.0% (0us) | Total: 0.4% (23.4ms) | Samples: 0

**Called by:**

- `#serve` (19)

**Calls:**

- `sourceUrl` (19)

### `sugarText`

`/Users/wrr/work/bun-koa/src/core/context/sugar.ts:187` | Self: 0.0% (0us) | Total: 0.5% (27.8ms) | Samples: 0

**Called by:**

- `dispatchDirect` (24)

**Calls:**

- `sourceMethod` (24)

### `matchPattern`

`/Users/wrr/work/bun-koa/src/router/trie.ts:209` | Self: 0.0% (0us) | Total: 0.3% (16.1ms) | Samples: 0

**Called by:**

- `dispatchRequest` (14)

**Calls:**

- `pushVariant` (9)
- `pushVariant` (5)

### `(module)`

`/Users/wrr/work/bun-koa/bench/route-shootout/diag/profile-loop.ts:11` | Self: 0.0% (0us) | Total: 0.1% (6.3ms) | Samples: 0

**Calls:**

- `routeShortcut` (1)

### `dispatchRequest`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:303` | Self: 0.0% (0us) | Total: 8.9% (446.5ms) | Samples: 0

**Called by:**

- `#serve` (381)

**Calls:**

- `getPath` (263)
- `getPath` (80)
- `getPath` (38)

### `dispatchRequest`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:319` | Self: 0.0% (0us) | Total: 0.9% (45.9ms) | Samples: 0

**Called by:**

- `#serve` (40)

**Calls:**

- `sourceMethod` (40)

### `dispatchRequest`

`/Users/wrr/work/bun-koa/src/core/dispatch.ts:329` | Self: 0.0% (0us) | Total: 18.8% (944.2ms) | Samples: 0

**Called by:**

- `#serve` (800)

**Calls:**

- `dispatchDirect` (771)
- `dispatchDirect` (29)

## Files

| Self% |    Self | File                                                                |
| ----: | ------: | ------------------------------------------------------------------- |
| 39.2% |   1.96s | `/Users/wrr/work/bun-koa/src/router/trie.ts`                        |
| 16.7% | 836.2ms | `[native code]`                                                     |
| 12.7% | 636.2ms | `/Users/wrr/work/bun-koa/src/utils/url.ts`                          |
| 12.0% | 605.3ms | `/Users/wrr/work/bun-koa/src/router/router.ts`                      |
|  8.3% | 416.4ms | `/Users/wrr/work/bun-koa/src/core/app.ts`                           |
|  2.8% | 142.5ms | `/Users/wrr/work/bun-koa/src/router/pattern.ts`                     |
|  2.7% | 135.2ms | `/Users/wrr/work/bun-koa/src/core/dispatch.ts`                      |
|  2.5% | 127.0ms | `/Users/wrr/work/bun-koa/src/core/context/context.ts`               |
|  1.9% |  97.2ms | `/Users/wrr/work/bun-koa/src/core/request-source.ts`                |
|  0.8% |  42.3ms | `/Users/wrr/work/bun-koa/src/core/context/sugar.ts`                 |
|  0.0% |   1.3ms | `/Users/wrr/work/bun-koa/bench/route-shootout/diag/profile-loop.ts` |
