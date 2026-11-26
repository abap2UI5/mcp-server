CLASS zcl_agent_mcp_window DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_row,
        id      TYPE i,
        title   TYPE string,
        status  TYPE string,
        due     TYPE string,
        qty     TYPE i,
        checked TYPE abap_bool,
      END OF ty_row.
    TYPES ty_rows TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.
    DATA rows    TYPE ty_rows.
    DATA total   TYPE i.
    DATA summary TYPE string.
    DATA mains   TYPE i.
  PRIVATE SECTION.
    " all rows; rows holds the ones loaded so far (the app-driven window)
    DATA all      TYPE ty_rows.
    " the order of the list - what the last SORT or FILTER request named
    DATA t_sort   TYPE z2ui5_if_client=>ty_t_bind_tab_sort.
    DATA t_filter TYPE z2ui5_if_client=>ty_t_bind_tab_filter.
    METHODS display
      IMPORTING
        client TYPE REF TO z2ui5_if_client.
    METHODS on_rows
      IMPORTING
        client TYPE REF TO z2ui5_if_client.
    METHODS load
      IMPORTING
        skip TYPE i
        top  TYPE i.
    METHODS passes
      IMPORTING
        is_row        TYPE ty_row
      RETURNING
        VALUE(result) TYPE abap_bool.
    METHODS cond_check
      IMPORTING
        is_row        TYPE ty_row
        is_cond       TYPE z2ui5_if_client=>ty_s_bind_tab_filter
      RETURNING
        VALUE(result) TYPE abap_bool.
    METHODS precedes
      IMPORTING
        is_a          TYPE ty_row
        is_b          TYPE ty_row
      RETURNING
        VALUE(result) TYPE abap_bool.
ENDCLASS.

CLASS zcl_agent_mcp_window IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA ls_row TYPE ty_row.
    DATA lv_day TYPE i.
    mains = mains + 1.
    IF client->check_on_init( ).
      DO 30 TIMES.
        CLEAR ls_row.
        ls_row-id = sy-index.
        ls_row-title = |order { sy-index }|.
        CASE sy-index MOD 3.
          WHEN 0.
            ls_row-status = `DONE`.
          WHEN 1.
            ls_row-status = `OPEN`.
          WHEN OTHERS.
            ls_row-status = `HOLD`.
        ENDCASE.
        lv_day = ( sy-index * 7 ) MOD 28 + 1.
        IF lv_day < 10.
          ls_row-due = |2026-03-0{ lv_day }|.
        ELSE.
          ls_row-due = |2026-03-{ lv_day }|.
        ENDIF.
        ls_row-qty = ( sy-index * 7 ) MOD 31.
        INSERT ls_row INTO TABLE all.
      ENDDO.
      load( skip = 0
            top  = 5 ).
      summary = `nothing yet`.
      display( client ).
      RETURN.
    ENDIF.
    CASE client->get_event( ).
      WHEN `ROWS`.
        on_rows( client ).
      WHEN `CHECK`.
        CLEAR summary.
        LOOP AT rows INTO ls_row WHERE checked = abap_true.
          summary = |{ summary }{ ls_row-id }:{ ls_row-qty } |.
        ENDLOOP.
        IF summary IS INITIAL.
          summary = `none`.
        ENDIF.
      WHEN `OPEN`.
        summary = |opened { client->get_event_arg( 1 ) }|.
    ENDCASE.
  ENDMETHOD.

  METHOD on_rows.
    FIELD-SYMBOLS <req> TYPE z2ui5_if_client=>ty_s_window_request.
    DATA ls_row TYPE ty_row.
    DATA(lr_req) = client->get( )-r_event_data.
    IF lr_req IS NOT BOUND.
      RETURN.
    ENDIF.
    ASSIGN lr_req->* TO <req>.
    " what was edited in the rows loaded so far stays when they are loaded anew
    LOOP AT rows INTO ls_row.
      MODIFY all FROM ls_row TRANSPORTING qty checked WHERE id = ls_row-id.
    ENDLOOP.
    IF <req>-reason = z2ui5_if_client=>cs_window_reason-more.
      load( skip = <req>-skip
            top  = <req>-top ).
    ELSE.
      t_sort = <req>-t_sort.
      t_filter = <req>-t_filter.
      load( skip = 0
            top  = <req>-top ).
    ENDIF.
  ENDMETHOD.

  METHOD load.
    DATA lt_hit TYPE ty_rows.
    DATA lv_at  TYPE i.
    DATA ls_row TYPE ty_row.
    DATA ls_hit TYPE ty_row.
    " the rows the filter lets through, in the order of the sort - a stable
    " insertion sort: a row goes before the first one it precedes
    LOOP AT all INTO ls_row.
      IF passes( ls_row ) = abap_false.
        CONTINUE.
      ENDIF.
      lv_at = lines( lt_hit ) + 1.
      LOOP AT lt_hit INTO ls_hit.
        IF precedes( is_a = ls_row
                     is_b = ls_hit ) = abap_true.
          lv_at = sy-tabix.
          EXIT.
        ENDIF.
      ENDLOOP.
      INSERT ls_row INTO lt_hit INDEX lv_at.
    ENDLOOP.
    total = lines( lt_hit ).
    " the first skip rows stay, top rows of the order follow them
    DATA(lv_skip) = nmin( val1 = skip
                          val2 = lines( rows ) ).
    IF lv_skip < lines( rows ).
      DELETE rows FROM lv_skip + 1.
    ENDIF.
    LOOP AT lt_hit INTO ls_row FROM lv_skip + 1.
      IF sy-tabix > lv_skip + top.
        EXIT.
      ENDIF.
      INSERT ls_row INTO TABLE rows.
    ENDLOOP.
  ENDMETHOD.

  METHOD passes.
    DATA lv_group TYPE i.
    DATA lv_hit   TYPE abap_bool.
    DATA ls_cond  TYPE z2ui5_if_client=>ty_s_bind_tab_filter.
    " the conditions of one group ORed, the groups ANDed
    result = abap_true.
    LOOP AT t_filter INTO ls_cond.
      IF ls_cond-group <> lv_group.
        IF lv_group IS NOT INITIAL AND lv_hit = abap_false.
          result = abap_false.
          RETURN.
        ENDIF.
        lv_group = ls_cond-group.
        lv_hit = abap_false.
      ENDIF.
      IF lv_hit = abap_false.
        lv_hit = cond_check( is_row  = is_row
                             is_cond = ls_cond ).
      ENDIF.
    ENDLOOP.
    IF lv_group IS NOT INITIAL AND lv_hit = abap_false.
      result = abap_false.
    ENDIF.
  ENDMETHOD.

  METHOD cond_check.
    DATA lv_text TYPE string.
    DATA lv_num  TYPE i.
    CASE is_cond-path.
      WHEN `TITLE` OR `STATUS` OR `DUE`.
        CASE is_cond-path.
          WHEN `TITLE`.
            lv_text = to_upper( is_row-title ).
          WHEN `STATUS`.
            lv_text = to_upper( is_row-status ).
          WHEN OTHERS.
            lv_text = is_row-due.
        ENDCASE.
        DATA(lv_value) = to_upper( is_cond-value1 ).
        CASE is_cond-operator.
          WHEN `EQ`.
            result = xsdbool( lv_text = lv_value ).
          WHEN `Contains`.
            result = xsdbool( lv_text CS lv_value ).
        ENDCASE.
        RETURN.
      WHEN `ID`.
        lv_num = is_row-id.
      WHEN `QTY`.
        lv_num = is_row-qty.
      WHEN OTHERS.
        RETURN.
    ENDCASE.
    CASE is_cond-operator.
      WHEN `EQ`.
        result = xsdbool( lv_num = is_cond-value1 ).
      WHEN `GT`.
        result = xsdbool( lv_num > is_cond-value1 ).
      WHEN `LT`.
        result = xsdbool( lv_num < is_cond-value1 ).
      WHEN `BT`.
        result = xsdbool( lv_num >= is_cond-value1 AND lv_num <= is_cond-value2 ).
    ENDCASE.
  ENDMETHOD.

  METHOD precedes.
    DATA lv_cmp  TYPE i.
    DATA ls_sort TYPE z2ui5_if_client=>ty_s_bind_tab_sort.
    " the first sorter that tells the two rows apart decides
    LOOP AT t_sort INTO ls_sort.
      CASE ls_sort-path.
        WHEN `ID`.
          lv_cmp = sign( is_a-id - is_b-id ).
        WHEN `QTY`.
          lv_cmp = sign( is_a-qty - is_b-qty ).
        WHEN `TITLE`.
          lv_cmp = COND #( WHEN is_a-title < is_b-title THEN -1 WHEN is_a-title > is_b-title THEN 1 ELSE 0 ).
        WHEN `STATUS`.
          lv_cmp = COND #( WHEN is_a-status < is_b-status THEN -1 WHEN is_a-status > is_b-status THEN 1 ELSE 0 ).
        WHEN `DUE`.
          lv_cmp = COND #( WHEN is_a-due < is_b-due THEN -1 WHEN is_a-due > is_b-due THEN 1 ELSE 0 ).
        WHEN OTHERS.
          lv_cmp = 0.
      ENDCASE.
      IF lv_cmp <> 0.
        IF ls_sort-descending = abap_true.
          lv_cmp = 0 - lv_cmp.
        ENDIF.
        result = xsdbool( lv_cmp < 0 ).
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD display.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`     v = `sap.m`
            )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc` ).

    DATA(page) = view->ele( `Page`
        )->a( n = `title` v = `Agent window app` ).

    page->tag( `Text`
        )->a( n = `text` v = client->_bind( summary )
    )->tag( `Text`
        )->a( n = `text` v = client->_bind( mains )
    )->tag( `Button`
        )->a( n = `text`  v = `Check`
        )->a( n = `press` v = client->_event( `CHECK` )
    )->tag( `Button`
        )->a( n = `text`  v = `Sort by quantity`
        )->a( n = `press` v = client->follow_up_action( val   = z2ui5_if_client=>cs_event-binding_call
                                                       t_arg = VALUE #( ( `orders` ) ( `items` ) ( `sort` ) ( `QTY` ) ( `X` ) ) )
    )->tag( `Button`
        )->a( n = `text`  v = `Only open`
        )->a( n = `press` v = client->follow_up_action( val   = z2ui5_if_client=>cs_event-binding_call
                                                       t_arg = VALUE #( ( `orders` ) ( `items` ) ( `filter` ) ( `STATUS` ) ( `EQ` ) ( `OPEN` ) ) ) ).

    page->ele( `Table`
        )->a( n = `id`               v = `orders`
        )->a( n = `headerText`       v = `Orders`
        )->a( n = `growing`          v = `true`
        )->a( n = `growingThreshold` v = `5`
        )->a( n = `items`            v = client->window_bind_tab( val    = rows
                                                                  total  = total
                                                                  event  = `ROWS`
                                                                  window = 5 )
        )->ele( `columns`
            )->tag( `Column`
            )->tag( `Column`
            )->tag( `Column`
            )->tag( `Column`
            )->tag( `Column`
            )->tag( `Column`
            )->tag( `Column`
        )->end(
        )->ele( `items`
            )->ele( `ColumnListItem`
                )->ele( `cells`
                    )->tag( `Text`
                        )->a( n = `text` v = `{ID}`
                    )->tag( `Text`
                        )->a( n = `text` v = `{TITLE}`
                    )->tag( `Text`
                        )->a( n = `text` v = `{STATUS}`
                    )->tag( `Text`
                        )->a( n = `text` v = `{DUE}`
                    )->tag( `Input`
                        )->a( n = `value` v = `{QTY}`
                    )->tag( `CheckBox`
                        )->a( n = `selected` v = `{CHECKED}`
                    )->tag( `Button`
                        )->a( n = `text`  v = `Open`
                        )->a( n = `press` v = client->_event( val = `OPEN` t_arg = VALUE #( ( `${ID}` ) ) ) ).

    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.
