ALTER EVENT plants.humidity_temperature_correction DISABLE;
ALTER EVENT plants.insert_fake_measurements ENABLE;

UPDATE plants.scenario_state
SET numeric_value = 75,
    text_value = 'normal',
    updated_at = NOW()
WHERE scenario_key = 'humidity_temperature_correction';

DELETE se
FROM plants.sensor_error se
WHERE se.error_code IN ('Warning_Hum_TempCorrection', 'Warning_Hum_AboveSetpoint')
  AND se.timestamp >= DATE_SUB(NOW(), INTERVAL 15 MINUTE);
