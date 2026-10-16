SET NAMES utf8mb4;
USE plants;
SET GLOBAL event_scheduler = ON;

CREATE TABLE IF NOT EXISTS plants.scenario_state (
  scenario_key VARCHAR(64) PRIMARY KEY,
  numeric_value DOUBLE NULL,
  text_value VARCHAR(255) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO scenario_state (scenario_key, numeric_value, text_value)
VALUES ('humidity_temperature_correction', 75, 'running')
ON DUPLICATE KEY UPDATE
  numeric_value = 75,
  text_value = 'running',
  updated_at = CURRENT_TIMESTAMP;

DELETE FROM plants.sensor_error
WHERE error_code IN ('Warning_Hum_AboveSetpoint', 'Warning_Hum_TempCorrection');

DROP EVENT IF EXISTS humidity_temperature_correction;

DELIMITER $$

CREATE DEFINER=`root`@`localhost` EVENT `humidity_temperature_correction`
ON SCHEDULE EVERY 2 SECOND
STARTS CURRENT_TIMESTAMP + INTERVAL 2 SECOND
ON COMPLETION NOT PRESERVE
DISABLE
DO
BEGIN
  DECLARE v_sensor_id INT DEFAULT NULL;
  DECLARE v_zone_id INT DEFAULT NULL;
  DECLARE v_current DOUBLE DEFAULT 75;
  DECLARE v_next DOUBLE DEFAULT 75;
  DECLARE v_phase VARCHAR(255) DEFAULT 'running';
  DECLARE v_ts DATETIME DEFAULT NULL;
  DECLARE v_alert_exists INT DEFAULT 0;

  SELECT id_sensor
    INTO v_sensor_id
  FROM plants.sensors
  WHERE id_parameterss = 2
  ORDER BY id_sensor
  LIMIT 1;

  IF v_sensor_id IS NOT NULL THEN
    SELECT COALESCE(numeric_value, 75), COALESCE(text_value, 'running')
      INTO v_current, v_phase
    FROM plants.scenario_state
    WHERE scenario_key = 'humidity_temperature_correction'
    LIMIT 1;

    IF v_phase = 'completed' THEN
      SET v_next = 75;
    ELSEIF v_phase = 'recovering' THEN
      SET v_next = GREATEST(75, v_current - 0.5);
    ELSE
      SET v_next = LEAST(82, v_current + 0.5);
    END IF;

    SET v_ts = DATE_ADD(NOW(), INTERVAL 3 SECOND);

    IF v_phase <> 'completed' THEN
      INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
      VALUES (v_sensor_id, 2, ROUND(v_next, 1), v_zone_id, NULL, v_ts);
    END IF;

    IF v_phase <> 'completed' THEN
      UPDATE plants.scenario_state
      SET numeric_value = CASE
            WHEN v_phase = 'recovering' AND v_next <= 75 THEN 75
            WHEN v_next >= 82 THEN 82
            ELSE v_next
          END,
          text_value = CASE
            WHEN v_phase = 'recovering' AND v_next <= 75 THEN 'completed'
            WHEN v_phase = 'recovering' THEN 'recovering'
            WHEN v_next >= 82 THEN 'alerted'
            ELSE 'running'
          END
      WHERE scenario_key = 'humidity_temperature_correction';
    END IF;

    IF v_phase NOT IN ('recovering', 'normal') AND v_next > 80 AND v_current <= 80 THEN
      SELECT COUNT(*)
        INTO v_alert_exists
      FROM plants.sensor_error
      WHERE error_code = 'Warning_Hum_AboveSetpoint'
        AND `timestamp` >= DATE_SUB(NOW(), INTERVAL 10 MINUTE);

      IF v_alert_exists = 0 THEN
        INSERT INTO plants.sensor_error (error_code, error_name, `timestamp`, id_sensor_number)
        VALUES (
          'Warning_Hum_AboveSetpoint',
          CONCAT('Влажность воздуха выше уставки 80%, значение ', ROUND(v_next, 1), ' %'),
          v_ts,
          v_sensor_id
        );
      END IF;
    END IF;

    IF v_phase NOT IN ('recovering', 'normal') AND v_next >= 82 AND v_current < 82 THEN
      SELECT COUNT(*)
        INTO v_alert_exists
      FROM plants.sensor_error
      WHERE error_code = 'Warning_Hum_TempCorrection'
        AND `timestamp` >= DATE_SUB(NOW(), INTERVAL 10 MINUTE);

      IF v_alert_exists = 0 THEN
        INSERT INTO plants.sensor_error (error_code, error_name, `timestamp`, id_sensor_number)
        VALUES (
          'Warning_Hum_TempCorrection',
          CONCAT('Влажность воздуха достигла ', ROUND(v_next, 1), '%'),
          v_ts,
          v_sensor_id
        );
      END IF;
    END IF;
  END IF;
END$$

DELIMITER ;
