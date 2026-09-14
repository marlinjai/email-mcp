import { ImapAdapter } from '../imap/adapter.js';
import { ProviderType } from '../../models/types.js';
import type { AccountCredentials, ProviderTypeValue } from '../../models/types.js';

export class ICloudAdapter extends ImapAdapter {
  override readonly providerType: ProviderTypeValue = ProviderType.ICloud;

  override async connect(credentials: AccountCredentials): Promise<void> {
    const passwordDefaults = {
      host: 'imap.mail.me.com',
      port: 993,
      tls: true,
      smtpHost: 'smtp.mail.me.com',
      smtpPort: 587,
    };
    const withDefaults: AccountCredentials = {
      ...credentials,
      password: { ...passwordDefaults, ...credentials.password! },
    };
    return super.connect(withDefaults);
  }
}
