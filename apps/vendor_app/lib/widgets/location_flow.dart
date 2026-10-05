import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/partner_session.dart';
import '../services/location/location_capture.dart';
import '../services/location/location_scope.dart';
import '../services/location/vendor_location_api.dart';
import '../session/session_controller.dart';
import 'location_sheet.dart';
import 'ui/vendor_ui.dart';

/// Keys for tests.
const Key kLocationBannerKey = ValueKey('location-banner');
const Key kLocationBannerActionKey = ValueKey('location-banner-action');
const Key kLocationRowKey = ValueKey('location-settings-row');

/// Saves one accepted fix through the session (PUT, then a profile refresh). Null on success, else the message to show.
Future<String?> _saveThroughSession(SessionController controller, LocationFix fix) async {
  final result = await controller.saveRestaurantLocation(fix);
  return result.ok ? null : locationSaveFailureText(result);
}

/// The capture sheet wired to Kraveo: detect, show the result, save to the signed-in restaurant.
/// [update] = the restaurant already has a pin, so saving asks "are you sure" first (it changes where riders go).
/// Returns true when the new pin was saved.
Future<bool> runRestaurantLocationFlow(BuildContext context, {bool update = false, bool prompt = false}) async {
  final controller = SessionScope.maybeOf(context);
  if (controller == null) return false;
  final services = LocationScope.of(context);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final fix = await showLocationDetectSheet(
    context,
    services: services,
    title: update ? 'Update restaurant location' : 'Set your restaurant location',
    hindiTitle: update ? 'रेस्टोरेंट की लोकेशन बदलें' : 'अपने रेस्टोरेंट की लोकेशन डालें',
    skipLabel: prompt ? 'Not now' : 'Cancel',
    skipSublabel: prompt ? 'अभी नहीं' : 'रद्द करें',
    onSave: (fix) => _saveThroughSession(controller, fix),
    confirmBeforeSave: update,
  );
  if (fix != null) {
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Restaurant location saved  ·  रेस्टोरेंट की लोकेशन सेव हो गई'), duration: Duration(seconds: 3)));
  }
  return fix != null;
}

/// The once-per-start "Set your restaurant location" sheet. Marks the prompt as shown first, so it never opens twice.
Future<void> promptForRestaurantLocation(BuildContext context) async {
  final controller = SessionScope.maybeOf(context);
  if (controller == null) return;
  controller.locationPromptShown = true;
  await runRestaurantLocationFlow(context, prompt: true);
}

/// True when the signed-in restaurant should be asked for its location now: the server says it has none, it is still
/// able to save one (pending or approved), and the sheet was not offered yet in this app start / login.
bool shouldPromptForLocation(SessionController? controller) {
  if (controller == null || controller.status != SessionStatus.signedIn || controller.locationPromptShown) return false;
  final me = controller.session;
  return me != null && me.needsLocation && (me.isApproved || me.approval == PartnerApproval.pending);
}

/// The persistent notice until the restaurant has a pin: shown on the home and the application-status screens.
class LocationBanner extends StatelessWidget {
  const LocationBanner({super.key, this.onAction});

  /// Defaults to opening the capture flow.
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      elevated: false,
      color: KraveoPalette.warning.withValues(alpha: 0.12),
      borderColor: KraveoPalette.warning.withValues(alpha: 0.6),
      padding: const EdgeInsets.all(10),
      child: LayoutBuilder(builder: (context, box) {
        final stacked = box.maxWidth < 520;
        final message = Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(LucideIcons.mapPinOff, size: 24, color: kDangerDeep),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text('Set your restaurant location. Riders cannot find you until this is done.',
                  style: KraveoType.bodySm.copyWith(color: k.ink, fontWeight: FontWeight.w800, fontSize: 15)),
              Text('अपने रेस्टोरेंट की लोकेशन डालें, वरना राइडर आप तक नहीं पहुँच पाएंगे।', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
            ]),
          ),
        ]);
        final button = KButton(
          key: kLocationBannerActionKey,
          label: 'Detect my location',
          sublabel: 'लोकेशन पता करें',
          expand: stacked,
          onPressed: onAction ?? () => runRestaurantLocationFlow(context),
        );
        if (!stacked) return Row(children: [Expanded(child: message), const SizedBox(width: 12), button]);
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [message, const SizedBox(height: 8), button]);
      }),
    );
  }
}
