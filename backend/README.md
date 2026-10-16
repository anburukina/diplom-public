# Backend (Node.js + Express + MySQL)

Минимальный REST-слой к MySQL из ТЗ. Эндпоинты совместимы с фронтом:
- `GET /api/dashboard`
- `GET /api/zones`
- `GET /api/zones/:id`
- `GET /api/zones/:id/measurements?from=&to=&param=`
- `GET /api/zones/:id/ndvi?from=&to=`
- `GET /api/sensors`
- `GET /api/errors`

## Настройка
1) Скопируй `.env.example` → `.env` и подставь свои креды MySQL:
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=...
DB_PASS=...
DB_NAME=hydro
PORT=3000
```
2) Установи зависимости:
```bash
cd backend
npm install
```

## Запуск
```bash
npm start        # prod
npm run dev      # с авто-перезапуском (--watch)
```

## Ожидаемая схема (минимум)
```
zones(id, name, technology, status, ndvi, row_num, col_num)
sensors(id, name, parameter, unit, zone_id, min_value, max_value)
sensors_measurements(id, sensor_id, zone_id, parameter, ts, value)
ndvi(id, zone_id, ts, ndvi)
sensor_error(id, ts, code, text, severity, sensor_id, zone_id)
```

## Проверка
- `curl http://localhost:3000/api/health`
- `curl http://localhost:3000/api/zones`
- `curl "http://localhost:3000/api/zones/Z1/measurements?from=2024-01-01T00:00:00Z&to=2024-12-31T00:00:00Z&param=temperature"`

## Привязка фронта/десктопа
В `frontend/.env` указать `VITE_API_URL=http://localhost:3000`, пересобрать фронт (`npm run build`), затем при желании пересобрать .exe (`cd приложение && npm run pack:win`).
