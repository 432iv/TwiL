INSERT INTO payment_methods (code, sort_order, active)
VALUES ('unpaid', 2, true)
ON CONFLICT (code) DO NOTHING;
