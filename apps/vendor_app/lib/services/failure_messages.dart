import 'vendor_backend.dart';

/// A short English line and its Hindi twin for a failed call, so a cook always knows what happened
/// and whether trying again makes sense.
class FailureText {
  const FailureText(this.english, this.hindi);
  final String english;
  final String hindi;

  String get both => '$english  ·  $hindi';
}

/// [code] is the server's machine code (`{code}` in the error body). Known codes get their own wording;
/// anything else falls back to the HTTP-level message.
FailureText failureText(ApiFailure failure, {String? serverMessage, String? code}) {
  switch (code) {
    case 'INVALID_TRANSITION':
      return const FailureText('This step is not possible any more: the order has moved on.', 'यह कदम अब नहीं हो सकता, ऑर्डर आगे बढ़ चुका है');
    case 'PAYMENT_NOT_CONFIRMED':
      return const FailureText('Payment is not confirmed. Do not cook this order.', 'पेमेंट पक्का नहीं हुआ, यह ऑर्डर न बनाएं');
    case 'CANNOT_REJECT':
      return const FailureText('An accepted order cannot be declined. Email kraveo.contact@gmail.com to cancel it.', 'स्वीकार किया ऑर्डर मना नहीं हो सकता, kraveo.contact@gmail.com पर ईमेल करें');
    case 'GROUP_WAITING':
      // Docs/22 section 10.1: the server's own sentence, shown plainly. The fallback is the same sentence.
      return FailureText(_serverOr('Waiting for the other restaurant(s) in this combined order to accept.', serverMessage), 'इस कंबाइंड ऑर्डर के दूसरे रेस्टोरेंट के स्वीकार करने का इंतज़ार करें');
    case 'ORDER_CLOSED':
      return const FailureText('This order is already finished or cancelled.', 'यह ऑर्डर पहले ही पूरा या रद्द हो चुका है');
    case 'ROLE_NOT_ALLOWED':
      return const FailureText('Your restaurant account cannot do this step.', 'यह कदम रेस्टोरेंट खाते से नहीं हो सकता');
    case 'PARTNER_NOT_APPROVED':
      return const FailureText('Your restaurant is not active on Kraveo right now.', 'आपका रेस्टोरेंट अभी चालू नहीं है');
    case 'NOT_FOUND':
      return const FailureText('This order is not available to your restaurant.', 'यह ऑर्डर आपके रेस्टोरेंट के लिए नहीं है');
  }
  switch (failure) {
    case ApiFailure.offline:
      return const FailureText('No internet. Check the connection and try again.', 'इंटरनेट नहीं है, फिर कोशिश करें');
    case ApiFailure.timeout:
      return const FailureText('Kraveo is slow to answer. Try again.', 'जवाब नहीं आया, फिर कोशिश करें');
    case ApiFailure.unauthorized:
      return const FailureText('Session expired. Please log in again.', 'फिर से लॉग इन करें');
    case ApiFailure.notApproved:
      return const FailureText('Your restaurant is not active on Kraveo right now.', 'आपका रेस्टोरेंट अभी चालू नहीं है');
    case ApiFailure.forbidden:
      return const FailureText('This is not allowed for your account.', 'यह आपके खाते के लिए मना है');
    case ApiFailure.notFound:
      return const FailureText('This order is no longer available.', 'यह ऑर्डर अब नहीं है');
    case ApiFailure.conflict:
      return FailureText(_withServer('The order changed meanwhile.', serverMessage), 'ऑर्डर बीच में बदल गया');
    case ApiFailure.invalid:
      return FailureText(_withServer('Kraveo did not allow this step.', serverMessage), 'यह कदम अभी नहीं हो सकता');
    case ApiFailure.rateLimited:
      return const FailureText('Too many tries. Wait a few seconds and try again.', 'थोड़ा रुककर फिर कोशिश करें');
    case ApiFailure.server:
      return const FailureText('Kraveo had a problem. Try again in a moment.', 'सर्वर में दिक्कत, थोड़ी देर में कोशिश करें');
  }
}

String _serverOr(String fallback, String? server) {
  final s = server?.trim() ?? '';
  return (s.isEmpty || s.length > 200) ? fallback : s;
}

String _withServer(String base, String? server) {
  final s = server?.trim() ?? '';
  if (s.isEmpty || s.length > 140) return base;
  return '$base ($s)';
}
