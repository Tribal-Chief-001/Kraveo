import 'package:flutter/material.dart';

/// Centres an empty state, but lets it scroll instead of overflowing on short screens
/// or at large system text sizes.
class KEmptyScroll extends StatelessWidget {
  const KEmptyScroll({super.key, required this.child, this.bottomInset = 0});

  final Widget child;
  final double bottomInset;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: EdgeInsets.only(bottom: bottomInset),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight - bottomInset),
          child: child,
        ),
      ),
    );
  }
}
