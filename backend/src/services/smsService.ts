import https from 'https';

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  provider?: string;
  error?: string;
}

/**
 * Dispatches 4-digit SMS OTP to Indian mobile number via configured SMS Gateway
 * Supports Fast2SMS (DLT Free Quick SMS in India), MSG91, Twilio, and console fallback.
 */
export const dispatchSmsOtp = async (phone: string, otp: string, role: string = 'STUDENT'): Promise<SendSmsResult> => {
  const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
  const fast2SmsKey = process.env.FAST2SMS_API_KEY;
  const msg91AuthKey = process.env.MSG91_AUTH_KEY;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;

  // 1. Fast2SMS Provider (Primary for Indian Campus Delivery)
  //    FAST2SMS_ROUTE=q   -> Quick SMS route: no DLT needed, ~Rs 5/SMS, custom text, numeric sender.
  //    FAST2SMS_ROUTE=otp -> Service route with Fast2SMS' fixed OTP template (cheaper; see their docs).
  if (fast2SmsKey && fast2SmsKey.length > 10) {
    const route = (process.env.FAST2SMS_ROUTE || 'otp').toLowerCase();
    const payload =
      route === 'q'
        ? { route: 'q', message: `Your Kraveo login code is ${otp}. It is valid for 5 minutes. Do not share it.`, language: 'english', flash: 0, numbers: cleanPhone }
        : { route: 'otp', variables_values: otp, numbers: cleanPhone };
    const data = JSON.stringify(payload);

    return new Promise<SendSmsResult>((resolve) => {
      const req = https.request(
        {
          hostname: 'www.fast2sms.com',
          port: 443,
          path: '/dev/bulkV2',
          method: 'POST',
          timeout: 8000,
          headers: { authorization: fast2SmsKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            let accepted = false;
            try { accepted = res.statusCode === 200 && JSON.parse(body)?.return === true; } catch { accepted = false; }
            console.log(`📲 [Fast2SMS] +91 ${cleanPhone.slice(0, 2)}******${cleanPhone.slice(-2)} route=${route} accepted=${accepted} status=${res.statusCode}`);
            resolve(accepted
              ? { success: true, provider: 'Fast2SMS', messageId: `f2s_${Date.now()}` }
              : { success: false, provider: 'Fast2SMS', error: `Fast2SMS rejected the request (HTTP ${res.statusCode}).` });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Fast2SMS timed out')));
      req.on('error', (err) => {
        console.warn(`⚠️ [Fast2SMS Gateway Error]: ${err.message}`);
        resolve({ success: false, provider: 'Fast2SMS', error: err.message });
      });
      req.write(data);
      req.end();
    });
  }

  // 2. No provider configured. In production we must NOT pretend the SMS was sent.
  if (process.env.NODE_ENV === 'production') {
    return { success: false, provider: 'none', error: 'No SMS provider is configured.' };
  }

  // Local / staging sandbox: log the code instead of sending.
  console.log(`📲 [SMS OTP Gateway] Dispatched 4-digit SMS OTP '${otp}' to +91 ${cleanPhone} (Role: ${role})`);
  return {
    success: true,
    provider: 'Local-Simulation-Ready',
    messageId: `sim_${Date.now()}`,
  };
};
