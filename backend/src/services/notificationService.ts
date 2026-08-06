import axios from 'axios';

export interface PushNotificationPayload {
  targetFcmToken?: string;
  topic?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

// Sends push notifications to dhaba tablet phones, runners, and student devices
export const sendPushNotification = async (payload: PushNotificationPayload): Promise<boolean> => {
  const fcmServerKey = process.env.FCM_SERVER_KEY;

  console.log(`🔔 [Notification Engine] Dispatching alert: "${payload.title}" - ${payload.body}`);

  if (!fcmServerKey) {
    console.log('ℹ️ [FCM Notification Log] Target device alert recorded (Set FCM_SERVER_KEY in .env for live APNS/FCM delivery).');
    return true;
  }

  try {
    await axios.post(
      'https://fcm.googleapis.com/fcm/send',
      {
        to: payload.targetFcmToken || `/topics/${payload.topic || 'all'}`,
        notification: {
          title: payload.title,
          body: payload.body,
          sound: 'default',
        },
        data: payload.data || {},
        priority: 'high',
      },
      {
        headers: {
          Authorization: `key=${fcmServerKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return true;
  } catch (err: any) {
    console.error('⚠️ [FCM Notification Error]:', err.message);
    return false;
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
