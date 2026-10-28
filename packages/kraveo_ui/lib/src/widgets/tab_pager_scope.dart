import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';

/// Makes the tab pager (the app shell's horizontal [PageView]) reachable from anywhere below it.
///
/// A horizontal scrollable nested in a tab (banner carousel, chip row) wins its own drags, so
/// the pager never sees them. Without help, a swipe that starts on such a widget and runs past
/// its last item would just stop ("stuck behind the banner"). Wrap the nested scrollable in a
/// [KTabPagerHandoff] and, at its first/last item, the leftover swipe moves the tab pager.
///
/// ```dart
/// // shell
/// KTabPagerScope(controller: pager, child: PageView(controller: pager, children: tabs));
/// // inside a tab
/// KTabPagerHandoff(child: PageView(physics: KTabPagerHandoff.pagePhysics, children: banners));
/// ```
class KTabPagerScope extends InheritedWidget {
  const KTabPagerScope({super.key, required this.controller, required super.child});

  final PageController controller;

  /// The pager above [context], or null when there is none (the widget then behaves as before).
  static PageController? maybeOf(BuildContext context) => context.getInheritedWidgetOfExactType<KTabPagerScope>()?.controller;

  @override
  bool updateShouldNotify(KTabPagerScope oldWidget) => controller != oldWidget.controller;
}

/// Forwards the horizontal overscroll of the scrollable below it to the [KTabPagerScope] pager,
/// as one continuous drag: the tab page follows the finger and settles (with the fling's
/// velocity) when the finger lifts. Does nothing without a [KTabPagerScope].
///
/// Rules: only horizontal scrollables, only overscroll caused by a finger (or the fling that
/// follows it), and the hand-off ends as soon as the nested scrollable moves back inside its
/// range. Needs a physics that reports overscroll ([ClampingScrollPhysics]; the iOS bouncing
/// physics never reports it): use [pagePhysics] for a nested [PageView].
class KTabPagerHandoff extends StatefulWidget {
  const KTabPagerHandoff({super.key, required this.child});

  final Widget child;

  /// Paging physics that report overscroll, so the hand-off works on every platform.
  static const ScrollPhysics pagePhysics = PageScrollPhysics(parent: ClampingScrollPhysics());

  /// Plain scrolling physics that report overscroll (chip rows, horizontal lists).
  static const ScrollPhysics listPhysics = ClampingScrollPhysics();

  @override
  State<KTabPagerHandoff> createState() => _KTabPagerHandoffState();
}

class _KTabPagerHandoffState extends State<KTabPagerHandoff> {
  Drag? _drag;
  PageController? _pager;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _pager = KTabPagerScope.maybeOf(context); // cached: notifications also arrive while the tree is torn down
  }

  @override
  void dispose() {
    final d = _drag;
    _drag = null;
    d?.cancel();
    super.dispose();
  }

  void _finish(double fingerVelocity) {
    final d = _drag;
    _drag = null;
    d?.end(DragEndDetails(velocity: Velocity(pixelsPerSecond: Offset(fingerVelocity, 0)), primaryVelocity: fingerVelocity));
  }

  bool _onScroll(ScrollNotification n) {
    if (n.metrics.axis != Axis.horizontal) return false;
    if (n is OverscrollNotification) {
      final drag = n.dragDetails;
      if (drag != null) {
        final pager = _pager;
        if (pager == null || !pager.hasClients) return false;
        // The scrollable's overscroll is the finger movement it could not use; negate for the finger.
        final finger = -n.overscroll;
        _drag ??= pager.position.drag(DragStartDetails(globalPosition: drag.globalPosition, sourceTimeStamp: drag.sourceTimeStamp), () => _drag = null);
        _drag!.update(DragUpdateDetails(
          globalPosition: drag.globalPosition,
          sourceTimeStamp: drag.sourceTimeStamp,
          delta: Offset(finger, 0),
          primaryDelta: finger,
        ));
      } else if (_drag != null) {
        _finish(-n.velocity); // the fling after the release, reported by the scrollable's ballistic
      }
    } else if (_drag != null) {
      if (n is ScrollEndNotification) {
        _finish(n.dragDetails?.primaryVelocity ?? 0);
      } else if (n is ScrollUpdateNotification) {
        _finish(0); // the finger turned back inside the nested range: let the tab page settle
      }
    }
    return false; // never swallow: the shell still sees its own notifications
  }

  @override
  Widget build(BuildContext context) => NotificationListener<ScrollNotification>(onNotification: _onScroll, child: widget.child);
}
