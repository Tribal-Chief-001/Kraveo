import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// The vertical scrollable of the Home feed. `find.byType(Scrollable).first` used to be the feed,
/// but HomeScreen's tab pager (a horizontal PageView) is now the outermost Scrollable.
Finder homeFeedScrollable() => find.descendant(of: find.byType(CustomScrollView).first, matching: find.byType(Scrollable)).first;
