import { Controller, Post, Body, Get, Req, UseGuards, Res, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthGuard } from '@nestjs/passport';
import { Response, Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { User } from '../user/user.entity';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly ds: DataSource,
  ) {}

  private async fetchUserRow(idCandidate?: any, emailCandidate?: any): Promise<any | null> {
    try {
      if (idCandidate) {
        const idNum = Number(idCandidate);
        if (!Number.isNaN(idNum)) {
          const sql = `SELECT * FROM "user" WHERE id = $1 LIMIT 1`;
          const rows = await this.ds.query(sql, [idNum]);
          if (Array.isArray(rows) && rows.length > 0) return rows[0];
        }
      }

      if (emailCandidate) {
        const emailNorm = String(emailCandidate).toLowerCase();
        const sql = `SELECT * FROM "user" WHERE lower(email) = $1 LIMIT 1`;
        const rows = await this.ds.query(sql, [emailNorm]);
        if (Array.isArray(rows) && rows.length > 0) return rows[0];
      }

      return null;
    } catch (err) {
      this.logger.warn('fetchUserRow failed', err as any);
      return null;
    }
  }

  @Post('login')
  async login(@Body() body: { email: string; password: string }, @Req() req: Request) {
    const result: any = await this.authService.login(body);

    try {
      const payload = (result && (result as any).user)
        ? (result as any).user
        : {
            sub: (result && (result as any).sub) || null,
            email: (result && (result as any).user && (result as any).user.email) || body.email || null,
          };

      if (payload && (payload.sub || payload.email)) {
        this.authService.recordLoginFromPayload(payload, req).catch(() => {});
      }
    } catch {
      // swallow
    }

    const token = result?.access_token ?? result?.token ?? result?.accessToken ?? null;
    const returnedUser = result?.user ?? result;

    let freshUser: any = null;
    try {
      const idCandidate = (returnedUser && (returnedUser.id ?? returnedUser.sub ?? returnedUser.user_id)) ?? null;
      const emailCandidate = (returnedUser && (returnedUser.email ?? returnedUser.user_email)) ?? body.email ?? null;

      freshUser = await this.fetchUserRow(idCandidate, emailCandidate);

      if (!freshUser) {
        if (idCandidate) {
          const idNum = Number(idCandidate);
          if (!Number.isNaN(idNum)) {
            freshUser = await this.ds.getRepository(User).findOne({ where: { id: idNum } } as any);
          }
        }
        if (!freshUser && emailCandidate) {
          freshUser = await this.ds.getRepository(User).findOne({ where: [{ email: String(emailCandidate).toLowerCase() }] } as any);
        }
      }
    } catch (err) {
      this.logger.warn('Failed to load fresh user record during login normalization', err as any);
      freshUser = null;
    }

    const src = freshUser ?? returnedUser ?? {};

    const sanitizedUser: any = {
      id: src.id ?? src.sub ?? null,
      email: src.email ?? null,
      name: src.name ?? null,
      require_security_setup: !!(src.require_security_setup ?? src.requireSecuritySetup ?? false),
      require_passphrase_setup: !!(src.require_passphrase_setup ?? src.requirePassphraseSetup ?? false),
      securityConfigured: !!(src.securityConfigured ?? src.security_configured ?? false),
      user_uid: src.user_uid ?? src.userUid ?? null,
      created_at: src.created_at ?? src.createdAt ?? null,
      // include plan / expiry so frontends can immediately show plan
      plan: src.plan ?? null,
      plan_expiry: src.plan_expiry ?? src.planExpiry ?? null,
    };

    if (token) {
      return { access_token: token, user: sanitizedUser };
    }

    return { user: sanitizedUser };
  }

  @Post('register')
  async register(
    @Body()
    body: {
      name: string;
      email: string;
      phone?: string;
      password: string;
      plan?: string;
      recoveryPassphrase: string;
      securityAnswers: Array<{ questionKey: string; answer: string }>;
    },
  ) {
    return this.authService.register(body);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Req() req: Request) {
    const jwtUser: any = (req as any).user ?? {};
    try {
      let freshUser: any = null;
      const idCandidate = jwtUser.sub ?? jwtUser.id ?? jwtUser.user_id;
      const emailCandidate = jwtUser.email ?? jwtUser.user_email;

      freshUser = await this.fetchUserRow(idCandidate, emailCandidate);

      if (!freshUser) {
        if (idCandidate) {
          const idNum = Number(idCandidate);
          if (!Number.isNaN(idNum)) {
            freshUser = await this.ds.getRepository(User).findOne({ where: { id: idNum } } as any);
          }
        }
        if (!freshUser && emailCandidate) {
          freshUser = await this.ds.getRepository(User).findOne({ where: [{ email: String(emailCandidate).toLowerCase() }] } as any);
        }
      }

      const src = freshUser ?? jwtUser;

      return {
        id: src.id ?? null,
        email: src.email ?? null,
        name: src.name ?? null,
        require_security_setup: !!(src.require_security_setup ?? src.requireSecuritySetup ?? false),
        require_passphrase_setup: !!(src.require_passphrase_setup ?? src.requirePassphraseSetup ?? false),
        securityConfigured: !!(src.securityConfigured ?? src.security_configured ?? false),
        user_uid: src.user_uid ?? src.userUid ?? null,
        created_at: src.created_at ?? src.createdAt ?? null,
        // expose plan info here too
        plan: src.plan ?? null,
        plan_expiry: src.plan_expiry ?? src.planExpiry ?? null,
      };
    } catch (err) {
      this.logger.warn('Failed to fetch fresh user record for /auth/me', err as any);
      return {
        id: jwtUser.sub ?? jwtUser.id ?? null,
        email: jwtUser.email ?? null,
        name: jwtUser.name ?? null,
        require_security_setup: !!(jwtUser.require_security_setup ?? jwtUser.requireSecuritySetup ?? false),
        require_passphrase_setup: !!(jwtUser.require_passphrase_setup ?? jwtUser.requirePassphraseSetup ?? false),
        plan: jwtUser.plan ?? null,
        plan_expiry: jwtUser.plan_expiry ?? null,
      };
    }
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(@Req() req, @Body() body: { oldPassword: string; newPassword: string }) {
    return this.authService.changePassword(req.user.sub, body.oldPassword, body.newPassword);
  }

  @Post('change-email')
  @UseGuards(JwtAuthGuard)
  async changeEmail(@Req() req, @Body() body: { newEmail: string }) {
    return this.authService.changeEmail(req.user.sub, body.newEmail);
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  async googleAuth() {}

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleAuthRedirect(@Req() req, @Res() res: Response) {
    const data = await this.authService.validateGoogleUser(req.user);
    try {
      const payload = (data && (data as any).user) ? (data as any).user : { sub: (data as any).sub, email: (data as any).user?.email ?? req.user?.email };
      if (payload && (payload.sub || payload.email)) {
        this.authService.recordLoginFromPayload(payload, req).catch(() => {});
      }
    } catch {}
    return res.redirect(`${process.env.FRONTEND_ORIGIN}/login?token=${data.access_token}`);
  }

  @Get('config')
  public getAuthConfig() {
    const smtpHost = this.configService.get<string>('SMTP_HOST');
    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASS');
    const mailEnabled = !!(smtpHost && smtpUser && smtpPass);
    const allowInsecure = String(this.configService.get('ALLOW_INSECURE_RESET') || '').toLowerCase() === 'true';
    return { mailEnabled, allowInsecure };
  }
}