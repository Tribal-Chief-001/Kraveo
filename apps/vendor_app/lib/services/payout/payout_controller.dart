import 'package:flutter/foundation.dart';
import '../../models/payout_account.dart';
import '../failure_messages.dart';
import 'payout_api.dart';

/// The restaurant's payout details: what is saved (masked), loading and saving states, and the per-login "Add payout
/// details to get paid" banner. It keeps NO full account number: a save takes a [PayoutInput], hands it to the API and
/// forgets it; only the masked account the server answers with is held.
class PayoutController extends ChangeNotifier {
  PayoutController({required this.api});

  final PayoutApi api;

  PayoutAccount? _account;
  bool _loaded = false;
  bool _loading = false;
  FailureText? _loadFailure;
  bool _saving = false;
  FailureText? _saveProblem;
  SavedPayout? _lastSaved;
  bool _bannerDismissed = false;
  bool _disposed = false;

  /// The saved details (masked), or null when none are saved or not read yet (see [loaded]).
  PayoutAccount? get account => _account;

  /// The server answered at least once, so [account] == null really means "nothing saved".
  bool get loaded => _loaded;
  bool get loading => _loading;

  /// Why the last read failed (cleared by the next successful read). Whatever was on screen stays.
  FailureText? get loadFailure => _loadFailure;
  bool get saving => _saving;

  /// Why the last save failed (cleared when the next save starts).
  FailureText? get saveProblem => _saveProblem;

  /// The answer of the last successful save (`changed` tells "saved" from "already saved").
  SavedPayout? get lastSaved => _lastSaved;

  /// The server confirmed that no payout details are saved.
  bool get missing => _loaded && _account == null;

  /// "Add payout details to get paid" is shown while details are missing and the owner has not closed it.
  bool get showBanner => missing && !_bannerDismissed;

  void dismissBanner() {
    if (_bannerDismissed) return;
    _bannerDismissed = true;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Reads the saved details. A second call while one is running does nothing.
  Future<void> load() async {
    if (_loading || _disposed) return;
    _loading = true;
    _loadFailure = null;
    _notify();
    final res = await api.fetchAccount();
    if (_disposed) return;
    _loading = false;
    if (res.ok) {
      _account = res.data;
      _loaded = true;
    } else {
      _loadFailure = payoutFailureText(res);
    }
    _notify();
  }

  /// Saves [input]. Returns true when the server stored it (or already had exactly these details). A second tap while
  /// a save is running does nothing, so a double tap sends one request.
  Future<bool> save(PayoutInput input) async {
    if (_saving || _disposed) return false;
    _saving = true;
    _saveProblem = null;
    _lastSaved = null;
    _notify();
    final res = await api.saveAccount(input);
    if (_disposed) return false;
    _saving = false;
    if (res.ok) {
      final saved = res.data!;
      _account = saved.account;
      _loaded = true;
      _loadFailure = null;
      _lastSaved = saved;
      _notify();
      return true;
    }
    _saveProblem = payoutFailureText(res);
    _notify();
    return false;
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
