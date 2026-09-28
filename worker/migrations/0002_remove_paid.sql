-- La app ya no conserva historial: limpiar pagos hechos con la versión anterior.
DELETE FROM reminders WHERE expense_id IN (SELECT id FROM expenses WHERE status = 'paid');
DELETE FROM expenses WHERE status = 'paid';
