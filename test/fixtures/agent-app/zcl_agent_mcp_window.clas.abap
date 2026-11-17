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
    DATA rows    TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.
    DATA summary TYPE string.
    DATA mains   TYPE i.
  PRIVATE SECTION.
    METHODS display
      IMPORTING
        client TYPE REF TO z2ui5_if_client.
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
        INSERT ls_row INTO TABLE rows.
      ENDDO.
      summary = `nothing yet`.
      display( client ).
      RETURN.
    ENDIF.
    CASE client->get_event( ).
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
        )->a( n = `items`            v = client->window_bind_tab( val = rows window = 5 )
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
