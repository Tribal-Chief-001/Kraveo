import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import * as fs from 'fs';
import * as path from 'path';

export interface PushNotificationPayload {
  targetFcmToken?: string;
  topic?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

// Initialize Firebase Admin SDK using service account key file
try {
  if (!getApps().length) {
    const keyPath = process.env.FIREBASE_KEY_PATH || path.join(__dirname, '../../firebase-key.json');
    if (fs.existsSync(keyPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      initializeApp({
        credential: cert(serviceAccount),
      });
      console.log(`🔥 [Firebase Admin SDK] Successfully initialized FCM Push Notification Engine for project: ${serviceAccount.project_id || 'kraveo'}`);
    } else {
      console.log('ℹ️ [Firebase Admin SDK] firebase-key.json not found (Push alerts logged locally).');
    }
  }
} catch (error: any) {
  console.error('⚠️ [Firebase Admin SDK Init Error]:', error.message);
}

// Sends push notifications to dhaba tablet phones, runners, and student devices
export const sendPushNotification = async (payload: PushNotificationPayload): Promise<boolean> => {
  console.log(`🔔 [FCM Notification Engine] Dispatching alert: "${payload.title}" - ${payload.body}`);

  try {
    const apps = getApps();
    if (apps.length > 0) {
      const messaging = getMessaging();
      if (payload.targetFcmToken) {
        await messaging.send({
          token: payload.targetFcmToken,
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data: payload.data || {},
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'kraveo_orders',
            },
          },
        });
      } else {
        await messaging.send({
          topic: payload.topic || 'all',
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data: payload.data || {},
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'kraveo_orders',
            },
          },
        });
      }
    }
    return true;
  } catch (err: any) {
    console.log(`ℹ️ [FCM Notification Dispatch]: Recorded alert "${payload.title}" (${err.message})`);
    return true;
  }
};

// Dispatch high-volume loud alarm push alert to dhaba cash counter tablet
export const triggerDhabaAlarmPushNotification = async (vendorId: string, orderId: string, totalAmount: number): Promise<void> => {
  await sendPushNotification({
    topic: `vendor_${vendorId}`,
    title: '🚨 NEW INCOMING ORDER ARRIVED!',
    body: `Order #${orderId} for ₹${totalAmount}. Tap to open kitchen alert screen!`,
    data: {
      eventType: 'NEW_ORDER',
      orderId,
      soundLoop: 'true',
    },
  });
};

// Dispatch drop-off arrival alert to student phone
export const triggerStudentArrivalNotification = async (studentPhone: string, orderId: string, otpCode: string): Promise<void> => {
  await sendPushNotification({
    title: '🛵 RUNNER ARRIVED AT HOSTEL GATE!',
    body: `Your runner is waiting at the gate. Handshake OTP code: ${otpCode}`,
    data: {
      eventType: 'RUNNER_ARRIVED',
      orderId,
      otpCode,
    },
  });
};
