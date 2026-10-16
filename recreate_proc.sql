DROP PROCEDURE IF EXISTS start_irrigation_for_zone;
DELIMITER $$
CREATE DEFINER=`root`@`localhost` PROCEDURE `start_irrigation_for_zone`(
  IN p_id_zone INT,
  IN p_trigger_type ENUM('SCHEDULED','MANUAL'),
  IN p_duration_sec INT,
  IN p_started_by_employee INT
)
BEGIN
  DECLARE v_id_technolog INT;
  DECLARE v_run_id BIGINT UNSIGNED;
  DECLARE v_started_at DATETIME;
  DECLARE v_duration_sec INT;

  SELECT id_technolog INTO v_id_technolog
  FROM plants.zones
  WHERE id_zone = p_id_zone
  LIMIT 1;

  IF v_id_technolog IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Zone not found or id_technolog is NULL';
  END IF;

  SET v_started_at = NOW();
  SET v_duration_sec = CASE
    WHEN v_id_technolog = 1 THEN GREATEST(60, IFNULL(p_duration_sec, 600))
    WHEN v_id_technolog = 2 THEN GREATEST(1, IFNULL(p_duration_sec, 10))
    ELSE GREATEST(1, IFNULL(p_duration_sec, 60))
  END;

  INSERT INTO plants.irrigation_runs (id_zone, trigger_type, started_by_employee, started_at, duration_sec)
  VALUES (p_id_zone, p_trigger_type, p_started_by_employee, v_started_at, v_duration_sec);

  SET v_run_id = LAST_INSERT_ID();

  SELECT v_run_id AS id_run;
END$$
DELIMITER ;
