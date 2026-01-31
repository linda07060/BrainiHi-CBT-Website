import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Index('ux_payments_paypal_order_id', ['paypalOrderId'], { unique: true })
@Index('ux_payments_paypal_capture_id', ['paypalCaptureId'], { unique: true })
@Index('ux_payments_client_temp_id', ['clientTempId'], { unique: false })
@Index('ux_payments_user_plan_minute', ['user_id', 'plan', 'billingPeriod', 'createdAtMinute'], { unique: true })
@Entity({ name: 'payments' })
export class Payment {
  @PrimaryGeneratedColumn()
  id: number;

  // user_id in DB, accessible in code as user_id
  @Column({ name: 'user_id', type: 'int', nullable: true })
  user_id: number | null;

  @Column({ name: 'plan', type: 'varchar', length: 64, nullable: true })
  plan: string | null;

  // Property in code: billingPeriod, DB column: billing_period
  @Column({ name: 'billing_period', type: 'varchar', length: 32, nullable: true })
  billingPeriod: string | null;

  @Column({ name: 'amount', type: 'numeric', precision: 12, scale: 2, default: 0.0 })
  amount: number;

  @Column({ name: 'currency', type: 'varchar', length: 8, default: 'USD' })
  currency: string;

  // PayPal ids mapped to snake_case DB columns
  @Column({ name: 'paypal_order_id', type: 'varchar', length: 128, nullable: true })
  paypalOrderId: string | null;

  @Column({ name: 'paypal_capture_id', type: 'varchar', length: 128, nullable: true })
  paypalCaptureId: string | null;

  @Column({ name: 'status', type: 'varchar', length: 32, default: 'pending' })
  status: string;

  @Column({ name: 'payer_email', type: 'varchar', length: 256, nullable: true })
  payerEmail: string | null;

  @Column({ name: 'payer_name', type: 'varchar', length: 256, nullable: true })
  payerName: string | null;

  // reason and change_to for invoice metadata
  @Column({ name: 'reason', type: 'varchar', length: 40, nullable: true })
  reason: string | null;

  @Column({ name: 'change_to', type: 'varchar', length: 64, nullable: true })
  change_to: string | null;

  // idempotency key (no longer used for uniqueness)
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  // client-supplied token to dedupe retries / concurrent creates
  @Column({ name: 'client_temp_id', type: 'varchar', length: 128, nullable: true })
  clientTempId: string | null;

  @Column({ name: 'raw', type: 'jsonb', nullable: true })
  raw: any;

  // minute-bucket for created_at (optional)
  @Column({ name: 'created_at_minute', type: 'timestamptz', nullable: true })
  createdAtMinute: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}